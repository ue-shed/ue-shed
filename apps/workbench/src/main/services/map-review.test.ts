import {
	makeReviewAuthoringTestLayer,
	makeReviewAuthoringSessionsTestLayer,
	makeReviewCaptureTestLayer,
	makeReviewRepositoryTestLayer,
	makeCameraFeedTestLayer,
	type ReviewAuthoringShape,
	ReviewAuthoringSessionError,
	type ReviewAuthoringSessionsShape,
	type ReviewCaptureShape,
	type ReviewSet
} from "@ue-shed/cameras";
import { it } from "@effect/vitest";
import { Observatory, ActorId, WorldScoutRefreshRate } from "@ue-shed/observatory";
import { makeEditorPlaySessionTestLayer } from "@ue-shed/engine-discovery";
import { makeRemoteControlClientTestLayer } from "@ue-shed/unreal-connection";
import { Effect, Layer, Queue, Ref, Stream } from "effect";
import { TestClock } from "effect/testing";
import { join } from "node:path";
import { expect } from "vitest";
import { makeLocalFilesTestLayer } from "../adapters/local-files.js";
import { makeWorkbenchWindowTestLayer, WorkbenchWindowTest } from "../adapters/electron-window.js";
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

const projectConfigured: WorkbenchConfigurationShape = {
	...configuredReview,
	review: { projectRoot, status: "project_configured" }
};

const dyingCapture: ReviewCaptureShape = { captureSet: () => Effect.die("not used") };
const dyingAuthoring: ReviewAuthoringShape = {
	inspectSelection: () => Effect.die("not used"),
	inspectSubject: () => Effect.die("not used"),
	previewCandidate: () => Effect.die("not used")
};
const clearOnlyRemoteControl = makeRemoteControlClientTestLayer((request) => {
	if (request.functionName === "ClearReviewPreviewSources") {
		return Effect.succeed({ cameras: [], schemaVersion: 1 });
	}
	return Effect.die(`unexpected remote call ${request.functionName}`);
});
const dyingAuthoringSessions: ReviewAuthoringSessionsShape = {
	approve: () => Effect.die("not used"),
	create: (args) =>
		Effect.succeed({
			candidates: [...args.candidates],
			contract: { name: "ue-shed-review-authoring-session", version: { major: 1, minor: 0 } },
			createdAt: "2026-07-20T00:00:00.000Z",
			diagnostics: [],
			discardedCandidateIds: [],
			id: "session-1",
			lifecycle: "active",
			realizations: [],
			reviewSet: {
				id: fixtureReviewSet.id,
				mapPath: args.selection.mapPath,
				path: args.reviewSetPath
			},
			subject: {
				actorPath: args.selection.actorPath,
				bounds: args.selection.bounds,
				displayName: args.selection.displayName,
				mapPath: args.selection.mapPath
			},
			updatedAt: "2026-07-20T00:00:00.000Z",
			viewId: args.viewId
		} as never),
	start: (args) => {
		if (args.selection.mapPath !== fixtureReviewSet.project.mapPath) {
			return Effect.fail(
				new ReviewAuthoringSessionError({
					message: "The selected subject belongs to a different map.",
					operation: "create",
					path: args.reviewSetPath ?? reviewSetPath,
					recovery: "Select an actor in the configured map."
				})
			);
		}
		return dyingAuthoringSessions.create({
			candidates: args.candidates,
			projectRoot: args.projectRoot,
			reviewSetPath: args.reviewSetPath ?? reviewSetPath,
			selection: args.selection,
			viewId: "structure-context"
		});
	},
	discard: () => Effect.die("not used"),
	latest: () => Effect.die("not used"),
	load: () => Effect.die("not used"),
	patch: () => Effect.die("not used"),
	recordProjection: () => Effect.die("not used"),
	reframe: () => Effect.die("not used"),
	resume: () => Effect.die("not used")
};
const WorkbenchMapReviewTestLive = WorkbenchMapReviewLive.pipe(
	Layer.provide(
		Layer.mergeAll(
			makeCameraFeedTestLayer(),
			makeWorkbenchWindowTestLayer(),
			clearOnlyRemoteControl,
			makeReviewAuthoringSessionsTestLayer(dyingAuthoringSessions),
			Layer.succeed(
				Observatory,
				Observatory.of({
					focus: () => Effect.die("not used"),
					observe: () => Stream.die("not used"),
					setObservationCadence: () => Effect.die("not used"),
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
							findSet: () => Effect.die("not used"),
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

it.effect("enters first-run Map Review setup when a project has no configured Review Set", () =>
	Effect.gen(function* () {
		const service = yield* WorkbenchMapReview;
		expect(yield* service.load()).toEqual({ status: "setup_required" });
	}).pipe(
		Effect.provide(
			WorkbenchMapReviewTestLive.pipe(
				Layer.provide(
					Layer.mergeAll(
						makeWorkbenchConfigurationLayer(projectConfigured),
						makeLocalFilesTestLayer(),
						makeReviewRepositoryTestLayer({
							discardStaging: () => Effect.die("not used"),
							findSet: () => Effect.die("not used"),
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
			viewCount: 1,
			views: [
				{
					displayName: "Front view",
					id: "view-1",
					resolution: { height: 1080, width: 1920 }
				}
			]
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
							findSet: () => Effect.die("not used"),
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
			expect(result.error.message).toContain("different map");
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
							findSet: () => Effect.die("not used"),
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
							findSet: () => Effect.die("not used"),
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
	"previews first-run authoring candidates from the pending Review Set capture profile",
	() =>
		Effect.gen(function* () {
			const service = yield* WorkbenchMapReview;
			const result = yield* service.previewAuthoringCandidate({
				candidateId: "facade_front",
				sessionId: "session-1"
			});
			expect(result).toEqual({
				bytes: new Uint8Array([9, 8, 7]),
				diagnostics: [],
				height: 180,
				pixelFormat: "png",
				projection: {
					margins: { bottom: 0.25, left: 0.25, right: 0.25, top: 0.25 },
					normalizedBounds: { maxX: 0.75, maxY: 0.75, minX: 0.25, minY: 0.25 },
					status: "projected",
					viewportStatus: "fully_within_viewport"
				},
				status: "ready",
				width: 320
			});
		}).pipe(
			Effect.provide(
				WorkbenchMapReviewLive.pipe(
					Layer.provide(
						Layer.mergeAll(
							makeCameraFeedTestLayer(),
							makeWorkbenchWindowTestLayer(),
							clearOnlyRemoteControl,
							makeReviewAuthoringSessionsTestLayer({
								...dyingAuthoringSessions,
								load: () =>
									Effect.succeed({
										candidates: [
											{
												approvedPose: {
													aspectRatio: "16:9",
													fieldOfViewDegrees: 60,
													location: { x: 1, y: 2, z: 3 },
													projection: "perspective",
													rotation: { pitch: -10, roll: 0, yaw: 90 }
												},
												diagnostics: [],
												displayName: "Facade front",
												id: "facade_front",
												recipe: {
													kind: "preset",
													margin: 0.12,
													preset: "facade_front",
													subjectBounds: {
														center: { x: 0, y: 0, z: 0 },
														extent: { x: 10, y: 10, z: 10 },
														rotation: { pitch: 0, roll: 0, yaw: 0 }
													},
													version: 1
												}
											}
										],
										contract: {
											name: "ue-shed-review-authoring-session",
											version: { major: 1, minor: 0 }
										},
										createdAt: "2026-07-20T00:00:00.000Z",
										diagnostics: [],
										discardedCandidateIds: [],
										id: "session-1",
										lifecycle: "active",
										pendingReviewSet: {
											...fixtureReviewSet,
											views: []
										},
										realizations: [],
										reviewSet: {
											id: fixtureReviewSet.id,
											mapPath: fixtureReviewSet.project.mapPath,
											path: reviewSetPath
										},
										subject: {
											actorPath:
												"/Game/Maps/Fixture.Fixture:PersistentLevel.Subject_0",
											bounds: {
												center: { x: 0, y: 0, z: 0 },
												extent: { x: 10, y: 10, z: 10 },
												rotation: { pitch: 0, roll: 0, yaw: 0 }
											},
											displayName: "Fixture Subject",
											mapPath: "/Game/Maps/Fixture"
										},
										updatedAt: "2026-07-20T00:00:00.000Z",
										viewId: "initial-view"
									} as never),
								recordProjection: (args) =>
									Effect.succeed({
										candidates: [],
										contract: {
											name: "ue-shed-review-authoring-session",
											version: { major: 1, minor: 0 }
										},
										createdAt: "2026-07-20T00:00:00.000Z",
										diagnostics: [],
										discardedCandidateIds: [],
										id: args.sessionId,
										lifecycle: "active",
										pendingReviewSet: {
											...fixtureReviewSet,
											views: []
										},
										realizations: [
											{
												candidateId: args.candidateId,
												diagnostics: [],
												projection: args.projection,
												recordedAt: "2026-07-20T00:00:00.000Z"
											}
										],
										reviewSet: {
											id: fixtureReviewSet.id,
											mapPath: fixtureReviewSet.project.mapPath,
											path: reviewSetPath
										},
										subject: {
											actorPath:
												"/Game/Maps/Fixture.Fixture:PersistentLevel.Subject_0",
											bounds: {
												center: { x: 0, y: 0, z: 0 },
												extent: { x: 10, y: 10, z: 10 },
												rotation: { pitch: 0, roll: 0, yaw: 0 }
											},
											displayName: "Fixture Subject",
											mapPath: "/Game/Maps/Fixture"
										},
										updatedAt: "2026-07-20T00:00:00.000Z",
										viewId: "initial-view"
									} as never)
							}),
							Layer.succeed(
								Observatory,
								Observatory.of({
									focus: () => Effect.die("not used"),
									observe: () => Stream.die("not used"),
									setObservationCadence: () => Effect.die("not used"),
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
							}),
							makeWorkbenchConfigurationLayer(projectConfigured),
							makeLocalFilesTestLayer(),
							makeReviewRepositoryTestLayer({
								discardStaging: () => Effect.die("not used"),
								findSet: () => Effect.die("not used"),
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
							makeReviewAuthoringTestLayer({
								...dyingAuthoring,
								inspectSubject: () =>
									Effect.succeed({
										actorPath:
											"/Game/Maps/Fixture.Fixture:PersistentLevel.Subject_0",
										bounds: {
											center: { x: 0, y: 0, z: 0 },
											extent: { x: 10, y: 10, z: 10 },
											rotation: { pitch: 0, roll: 0, yaw: 0 }
										},
										contract: {
											name: "ue-shed-review-subject-inspection" as const,
											version: { major: 1, minor: 0 }
										},
										displayName: "Fixture Subject",
										mapPath: "/Game/Maps/Fixture",
										status: "ready" as const
									} as never),
								previewCandidate: () =>
									Effect.succeed({
										bytes: new Uint8Array([9, 8, 7]),
										height: 180,
										projection: {
											margins: {
												bottom: 0.25,
												left: 0.25,
												right: 0.25,
												top: 0.25
											},
											normalizedBounds: {
												maxX: 0.75,
												maxY: 0.75,
												minX: 0.25,
												minY: 0.25
											},
											status: "projected" as const,
											viewportStatus: "fully_within_viewport" as const
										},
										width: 320
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
								findSet: () => Effect.die("not used"),
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

const durableAuthoringSession = {
	candidates: [
		{
			approvedPose: {
				aspectRatio: "16:9" as const,
				fieldOfViewDegrees: 60,
				location: { x: 1, y: 2, z: 3 },
				projection: "perspective" as const,
				rotation: { pitch: -10, roll: 0, yaw: 90 }
			},
			diagnostics: [],
			displayName: "Facade front",
			id: "facade_front",
			recipe: {
				kind: "preset" as const,
				margin: 0.12,
				preset: "facade_front" as const,
				subjectBounds: {
					center: { x: 0, y: 0, z: 0 },
					extent: { x: 10, y: 10, z: 10 },
					rotation: { pitch: 0, roll: 0, yaw: 0 }
				},
				version: 1 as const
			}
		}
	],
	contract: {
		name: "ue-shed-review-authoring-session" as const,
		version: { major: 1 as const, minor: 0 as const }
	},
	createdAt: "2026-07-20T00:00:00.000Z",
	diagnostics: [],
	discardedCandidateIds: ["context_three_quarter"],
	draftPose: {
		aspectRatio: "16:9" as const,
		fieldOfViewDegrees: 58,
		location: { x: 1, y: 2, z: 28 },
		projection: "perspective" as const,
		rotation: { pitch: -10, roll: 0, yaw: 90 }
	},
	id: "session-recover",
	lifecycle: "active" as const,
	manualReason: "Lift above foreground",
	realizations: [],
	reviewSet: {
		id: fixtureReviewSet.id,
		mapPath: fixtureReviewSet.project.mapPath,
		path: reviewSetPath
	},
	selectedCandidateId: "facade_front",
	subject: {
		actorPath: "/Game/Maps/Fixture.Fixture:PersistentLevel.Subject_0",
		bounds: {
			center: { x: 0, y: 0, z: 0 },
			extent: { x: 10, y: 10, z: 10 },
			rotation: { pitch: 0, roll: 0, yaw: 0 }
		},
		displayName: "Fixture Subject",
		mapPath: "/Game/Maps/Fixture"
	},
	updatedAt: "2026-07-20T00:00:01.000Z",
	viewId: "view-1"
};

it.effect("resumes the latest persisted authoring session after a fresh service start", () =>
	Effect.gen(function* () {
		const service = yield* WorkbenchMapReview;
		const result = yield* service.authoringResume(undefined);
		expect(result).toMatchObject({
			sessionId: "session-recover",
			status: "ready",
			viewId: "view-1"
		});
		if (result.status !== "ready") return;
		expect(result.session).toMatchObject({
			discardedCandidateIds: ["context_three_quarter"],
			lifecycle: "active",
			manualReason: "Lift above foreground",
			selectedCandidateId: "facade_front"
		});
		expect(result.session?.draftPose).toMatchObject({ location: { z: 28 } });
	}).pipe(
		Effect.provide(
			WorkbenchMapReviewLive.pipe(
				Layer.provide(
					Layer.mergeAll(
						makeCameraFeedTestLayer(),
						makeWorkbenchWindowTestLayer(),
						clearOnlyRemoteControl,
						makeWorkbenchConfigurationLayer(configuredReview),
						makeLocalFilesTestLayer(),
						makeReviewRepositoryTestLayer({
							discardStaging: () => Effect.die("not used"),
							findSet: () => Effect.die("not used"),
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
						makeReviewAuthoringTestLayer(dyingAuthoring),
						makeReviewAuthoringSessionsTestLayer({
							...dyingAuthoringSessions,
							latest: () => Effect.succeed(durableAuthoringSession as never),
							resume: () =>
								Effect.succeed({
									session: durableAuthoringSession as never,
									status: "resumable" as const
								})
						}),
						Layer.succeed(
							Observatory,
							Observatory.of({
								focus: () => Effect.die("not used"),
								observe: () => Stream.die("not used"),
								setObservationCadence: () => Effect.die("not used"),
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
			)
		)
	)
);

const staleRecoveryGuidance =
	"The stored draft is retained. Reframe the subject explicitly or discard the stale session.";

it.effect("surfaces stale bounds recovery and refuses Keep View approval", () =>
	Effect.gen(function* () {
		const service = yield* WorkbenchMapReview;
		const resumed = yield* service.authoringResume({ sessionId: "session-recover" });
		expect(resumed).toMatchObject({
			recovery: staleRecoveryGuidance,
			sessionId: "session-recover",
			status: "ready"
		});
		if (resumed.status !== "ready") return;
		expect(resumed.session?.lifecycle).toBe("stale");
		const approval = yield* service.approveAuthoring({ sessionId: "session-recover" });
		expect(approval).toMatchObject({
			error: {
				message: "The authoring session became stale before approval.",
				recovery: staleRecoveryGuidance
			},
			status: "failed"
		});
	}).pipe(
		Effect.provide(
			WorkbenchMapReviewLive.pipe(
				Layer.provide(
					Layer.mergeAll(
						makeCameraFeedTestLayer(),
						makeWorkbenchWindowTestLayer(),
						clearOnlyRemoteControl,
						makeWorkbenchConfigurationLayer(configuredReview),
						makeLocalFilesTestLayer(),
						makeReviewRepositoryTestLayer({
							discardStaging: () => Effect.die("not used"),
							findSet: () => Effect.die("not used"),
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
						makeReviewAuthoringTestLayer(dyingAuthoring),
						makeReviewAuthoringSessionsTestLayer({
							...dyingAuthoringSessions,
							approve: () =>
								Effect.succeed({
									reasons: ["bounds_changed" as const],
									recovery: staleRecoveryGuidance,
									session: {
										...durableAuthoringSession,
										lifecycle: "stale" as const
									} as never,
									status: "stale" as const
								}),
							load: () =>
								Effect.succeed({
									...durableAuthoringSession,
									lifecycle: "stale" as const
								} as never),
							resume: () =>
								Effect.succeed({
									reasons: ["bounds_changed" as const],
									recovery: staleRecoveryGuidance,
									session: {
										...durableAuthoringSession,
										lifecycle: "stale" as const
									} as never,
									status: "stale" as const
								})
						}),
						Layer.succeed(
							Observatory,
							Observatory.of({
								focus: () => Effect.die("not used"),
								observe: () => Stream.die("not used"),
								setObservationCadence: () => Effect.die("not used"),
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
			)
		)
	)
);

function observationActor(
	id: string,
	x: number,
	y: number
): import("@ue-shed/observatory").ObservedActor {
	return {
		bounds: { center: { x, y, z: 0 }, extent: { x: 10, y: 10, z: 10 } },
		className: "FixtureMover",
		displayName: id,
		id: ActorId.make(id),
		location: { x, y, z: 0 },
		path: `/Game/Fixture.${id}`,
		rotation: { x: 0, y: 0, z: 0 }
	};
}

const settle = Effect.gen(function* () {
	for (let index = 0; index < 25; index += 1) yield* Effect.yieldNow;
});

it.effect("subscribes to world observations, coalesces transform bursts, and cleans up", () =>
	Effect.gen(function* () {
		const {
			CatalogRevision,
			ObservationSessionId,
			PacketSequence,
			StreamActorIndex,
			WorldActorSnapshot,
			WorldIndexedTransform,
			WorldTransform,
			WorldTransformBatch,
			applyWorldObservationEvent,
			catalogFromSnapshot,
			connectingState
		} = yield* Effect.promise(() => import("@ue-shed/observatory"));
		const observationQueue =
			yield* Queue.unbounded<import("@ue-shed/observatory").WorldObservationState>();
		const activeObservers = yield* Ref.make(0);

		const windowLayer = makeWorkbenchWindowTestLayer();
		const serviceLayer = WorkbenchMapReviewLive.pipe(
			Layer.provide(
				Layer.mergeAll(
					makeCameraFeedTestLayer(),
					clearOnlyRemoteControl,
					makeReviewAuthoringSessionsTestLayer(dyingAuthoringSessions),
					Layer.succeed(
						Observatory,
						Observatory.of({
							focus: () => Effect.die("not used"),
							observe: () =>
								Stream.unwrap(
									Effect.gen(function* () {
										yield* Ref.update(activeObservers, (count) => count + 1);
										return Stream.fromQueue(observationQueue).pipe(
											Stream.ensuring(
												Ref.update(activeObservers, (count) => count - 1)
											)
										);
									})
								),
							setObservationCadence: () => Effect.die("not used"),
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
					}),
					makeWorkbenchConfigurationLayer(notConfigured),
					makeLocalFilesTestLayer(),
					makeReviewRepositoryTestLayer({
						discardStaging: () => Effect.die("not used"),
						findSet: () => Effect.die("not used"),
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
			),
			Layer.provideMerge(windowLayer)
		);

		yield* Effect.gen(function* () {
			const mapReview = yield* WorkbenchMapReview;
			const windowTest = yield* WorkbenchWindowTest;
			yield* mapReview.subscribeWorldObservations(WorldScoutRefreshRate.make(30));

			const snapshot = WorldActorSnapshot.make({
				actors: [observationActor("a", 1, 2), observationActor("b", 3, 4)],
				capturedAt: "2026-07-21T00:00:00.000Z",
				mapPath: "/Game/Fixture",
				sequence: 1,
				worldKind: "editor",
				worldSeconds: 1
			});
			const sessionId = ObservationSessionId.make("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
			const revision = CatalogRevision.make(1n);
			const { catalog, transforms } = catalogFromSnapshot(snapshot, sessionId, revision);
			const live = applyWorldObservationEvent(connectingState(), {
				_tag: "catalog",
				catalog,
				initialTransforms: transforms
			}).state;
			yield* Queue.offer(observationQueue, live);

			const moved = applyWorldObservationEvent(live, {
				_tag: "transforms",
				batch: WorldTransformBatch.make({
					actorsChanged: 1,
					actorsSampled: 2,
					producerMonotonicMs: 10,
					producerReplacements: 0,
					revision,
					sequence: PacketSequence.make(2n),
					sessionId,
					transforms: [
						WorldIndexedTransform.make({
							streamIndex: StreamActorIndex.make(0),
							transform: WorldTransform.make({
								location: { x: 10, y: 20, z: 0 },
								rotation: { x: 0, y: 0, z: 0 }
							})
						})
					],
					worldSeconds: 2
				})
			}).state;
			const movedAgain = applyWorldObservationEvent(moved, {
				_tag: "transforms",
				batch: WorldTransformBatch.make({
					actorsChanged: 1,
					actorsSampled: 2,
					producerMonotonicMs: 11,
					producerReplacements: 1,
					revision,
					sequence: PacketSequence.make(3n),
					sessionId,
					transforms: [
						WorldIndexedTransform.make({
							streamIndex: StreamActorIndex.make(1),
							transform: WorldTransform.make({
								location: { x: 30, y: 40, z: 0 },
								rotation: { x: 0, y: 0, z: 0 }
							})
						})
					],
					worldSeconds: 3
				})
			}).state;
			yield* Queue.offer(observationQueue, moved);
			yield* Queue.offer(observationQueue, movedAgain);
			yield* settle;
			expect(yield* mapReview.worldObservationPresentationReplacements()).toBeGreaterThan(0);
			yield* TestClock.adjust("20 millis");
			yield* settle;

			const afterTransforms = yield* windowTest.sent();
			const catalogEventIndex = afterTransforms.findIndex(
				(entry) =>
					entry.channel === "map-review:world-observation" &&
					(entry.payload as { kind: string }).kind === "catalog"
			);
			const transformEvents = afterTransforms.filter(
				(entry) =>
					entry.channel === "map-review:world-observation" &&
					(entry.payload as { kind: string }).kind === "transforms"
			);
			expect(catalogEventIndex).toBeGreaterThanOrEqual(0);
			expect(transformEvents.length).toBeGreaterThanOrEqual(1);
			const lastTransform = transformEvents.at(-1)?.payload as {
				readonly transforms: ReadonlyArray<{ readonly streamIndex: number }>;
			};
			expect(lastTransform.transforms).toHaveLength(2);
			expect(lastTransform.transforms.map((transform) => transform.streamIndex)).toEqual([
				0, 1
			]);

			yield* mapReview.unsubscribeWorldObservations();
			yield* settle;
			expect(yield* Ref.get(activeObservers)).toBe(0);
		}).pipe(Effect.provide(serviceLayer));
	})
);

it.effect("keeps observation live while focusing an actor and retuning cadence", () =>
	Effect.gen(function* () {
		const {
			CatalogRevision,
			ObservationSessionId,
			WorldActorSnapshot,
			WorldScoutRefreshRate,
			applyWorldObservationEvent,
			catalogFromSnapshot,
			connectingState
		} = yield* Effect.promise(() => import("@ue-shed/observatory"));
		const observationQueue =
			yield* Queue.unbounded<import("@ue-shed/observatory").WorldObservationState>();
		const observeStarts = yield* Ref.make(0);
		const cadenceUpdates = yield* Ref.make<number[]>([]);

		const windowLayer = makeWorkbenchWindowTestLayer();
		const serviceLayer = WorkbenchMapReviewLive.pipe(
			Layer.provide(
				Layer.mergeAll(
					makeCameraFeedTestLayer(),
					clearOnlyRemoteControl,
					makeReviewAuthoringSessionsTestLayer(dyingAuthoringSessions),
					Layer.succeed(
						Observatory,
						Observatory.of({
							focus: (endpoint, actorId) =>
								Effect.succeed({
									actorId,
									authoringSubject: "selected" as const,
									status: "focused" as const
								}),
							observe: () =>
								Stream.unwrap(
									Ref.update(observeStarts, (count) => count + 1).pipe(
										Effect.as(Stream.fromQueue(observationQueue))
									)
								),
							setObservationCadence: (_endpoint, cadenceHz) =>
								Ref.update(cadenceUpdates, (updates) => [
									...updates,
									cadenceHz
								]).pipe(Effect.as(cadenceHz)),
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
					}),
					makeWorkbenchConfigurationLayer(notConfigured),
					makeLocalFilesTestLayer(),
					makeReviewRepositoryTestLayer({
						discardStaging: () => Effect.die("not used"),
						findSet: () => Effect.die("not used"),
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
			),
			Layer.provideMerge(windowLayer)
		);

		yield* Effect.gen(function* () {
			const mapReview = yield* WorkbenchMapReview;
			const windowTest = yield* WorkbenchWindowTest;
			yield* mapReview.subscribeWorldObservations(WorldScoutRefreshRate.make(10));
			yield* settle;
			expect(yield* Ref.get(observeStarts)).toBe(1);

			const snapshot = WorldActorSnapshot.make({
				actors: [observationActor("a", 1, 2)],
				capturedAt: "2026-07-21T00:00:00.000Z",
				mapPath: "/Game/Fixture",
				sequence: 1,
				worldKind: "editor",
				worldSeconds: 1
			});
			const sessionId = ObservationSessionId.make("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
			const revision = CatalogRevision.make(1n);
			const { catalog, transforms } = catalogFromSnapshot(snapshot, sessionId, revision);
			yield* Queue.offer(
				observationQueue,
				applyWorldObservationEvent(connectingState(), {
					_tag: "catalog",
					catalog,
					initialTransforms: transforms
				}).state
			);
			yield* settle;
			yield* TestClock.adjust("20 millis");
			yield* settle;

			yield* mapReview.focusActor(ActorId.make("a"), true);
			yield* settle;
			yield* TestClock.adjust("20 millis");
			yield* settle;
			yield* mapReview.setWorldObservationRate(WorldScoutRefreshRate.make(20));
			yield* settle;

			const sent = yield* windowTest.sent();
			expect(
				sent.some(
					(entry) =>
						entry.channel === "map-review:world-observation" &&
						(entry.payload as { kind: string; status?: string }).kind === "catalog" &&
						(entry.payload as { status?: string }).status === "stale"
				)
			).toBe(false);
			expect(yield* Ref.get(observeStarts)).toBe(1);
			expect(yield* Ref.get(cadenceUpdates)).toEqual([20]);
			yield* mapReview.unsubscribeWorldObservations();
		}).pipe(Effect.provide(serviceLayer));
	})
);

const livePreviewSession = {
	candidates: [
		{
			approvedPose: {
				aspectRatio: "16:9" as const,
				fieldOfViewDegrees: 60,
				location: { x: 10, y: 20, z: 30 },
				projection: "perspective" as const,
				rotation: { pitch: -12, roll: 0, yaw: 45 }
			},
			diagnostics: [],
			displayName: "Facade front",
			id: "facade_front",
			recipe: {
				kind: "preset" as const,
				margin: 0.12,
				preset: "facade_front" as const,
				subjectBounds: {
					center: { x: 0, y: 0, z: 0 },
					extent: { x: 10, y: 10, z: 10 },
					rotation: { pitch: 0, roll: 0, yaw: 0 }
				},
				version: 1 as const
			}
		}
	],
	contract: {
		name: "ue-shed-review-authoring-session" as const,
		version: { major: 1 as const, minor: 0 as const }
	},
	createdAt: "2026-07-20T00:00:00.000Z",
	diagnostics: [],
	discardedCandidateIds: [],
	id: "session-live",
	lifecycle: "active" as const,
	pendingReviewSet: {
		...fixtureReviewSet,
		views: []
	},
	realizations: [],
	reviewSet: {
		id: fixtureReviewSet.id,
		mapPath: fixtureReviewSet.project.mapPath,
		path: reviewSetPath
	},
	subject: {
		actorPath: "/Game/Maps/Fixture.Fixture:PersistentLevel.Subject_0",
		bounds: {
			center: { x: 0, y: 0, z: 0 },
			extent: { x: 10, y: 10, z: 10 },
			rotation: { pitch: 0, roll: 0, yaw: 0 }
		},
		displayName: "Fixture Subject",
		mapPath: "/Game/Maps/Fixture"
	},
	updatedAt: "2026-07-20T00:00:00.000Z",
	viewId: "initial-view"
};

it.effect("streams live BGRA authoring previews while PIE is running", () =>
	Effect.gen(function* () {
		const service = yield* WorkbenchMapReview;
		const result = yield* service.previewAuthoringCandidate({
			candidateId: "facade_front",
			sessionId: "session-live"
		});
		expect(result).toEqual({
			bytes: new Uint8Array([10, 20, 30, 255]),
			cameraIndex: 0,
			diagnostics: [],
			height: 180,
			pixelFormat: "bgra8",
			status: "ready",
			width: 320
		});
	}).pipe(
		Effect.provide(
			WorkbenchMapReviewLive.pipe(
				Layer.provide(
					Layer.mergeAll(
						makeCameraFeedTestLayer({
							latestFrames: Effect.succeed(
								new Map([
									[
										0,
										{
											cameraId: "cam-0",
											cameraIndex: 0,
											captureMonotonicMs: 1,
											height: 180,
											pixels: new Uint8Array([10, 20, 30, 255]),
											producerId: "producer",
											readbackDrops: 0,
											readbackLatencyMs: 1,
											receivedMonotonicMs: 2,
											sequence: 1n,
											sessionId: "session",
											transportReplacements: 0,
											width: 320,
											worldSeconds: 0.1
										}
									]
								])
							)
						}),
						makeWorkbenchWindowTestLayer(),
						makeRemoteControlClientTestLayer((request) => {
							if (request.functionName === "EnsureReviewPreviewSources") {
								return Effect.succeed({
									cameras: [
										{
											cameraId: "cam-0",
											candidateId: "facade_front",
											displayName: "facade_front",
											height: 180,
											index: 0,
											width: 320
										}
									],
									schemaVersion: 1
								});
							}
							if (request.functionName === "ClearReviewPreviewSources") {
								return Effect.succeed({ cameras: [], schemaVersion: 1 });
							}
							return Effect.die(`unexpected remote call ${request.functionName}`);
						}),
						makeReviewAuthoringSessionsTestLayer({
							...dyingAuthoringSessions,
							load: () => Effect.succeed(livePreviewSession as never)
						}),
						Layer.succeed(
							Observatory,
							Observatory.of({
								focus: () => Effect.die("not used"),
								observe: () => Stream.die("not used"),
								setObservationCadence: () => Effect.die("not used"),
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
									state: {
										mode: "play",
										sessionId: "pie-1" as never,
										status: "running"
									}
								}),
							stop: () => Effect.die("not used")
						}),
						makeWorkbenchConfigurationLayer(projectConfigured),
						makeLocalFilesTestLayer(),
						makeReviewRepositoryTestLayer({
							discardStaging: () => Effect.die("not used"),
							findSet: () => Effect.die("not used"),
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
						makeReviewAuthoringTestLayer({
							...dyingAuthoring,
							previewCandidate: () =>
								Effect.die("PNG preview must not run while PIE is active")
						})
					)
				)
			)
		)
	)
);

it.effect("blocks Capture Set while PIE is running", () =>
	Effect.gen(function* () {
		const service = yield* WorkbenchMapReview;
		const result = yield* service.capture({ viewIds: ["view-1"] });
		expect(result).toMatchObject({
			policy: { code: "play_session_active" },
			status: "blocked"
		});
	}).pipe(
		Effect.provide(
			WorkbenchMapReviewLive.pipe(
				Layer.provide(
					Layer.mergeAll(
						makeCameraFeedTestLayer(),
						makeWorkbenchWindowTestLayer(),
						clearOnlyRemoteControl,
						makeReviewAuthoringSessionsTestLayer(dyingAuthoringSessions),
						Layer.succeed(
							Observatory,
							Observatory.of({
								focus: () => Effect.die("not used"),
								observe: () => Stream.die("not used"),
								setObservationCadence: () => Effect.die("not used"),
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
									state: {
										mode: "play",
										sessionId: "pie-1" as never,
										status: "running"
									}
								}),
							stop: () => Effect.die("not used")
						}),
						makeWorkbenchConfigurationLayer(configuredReview),
						makeLocalFilesTestLayer(),
						makeReviewRepositoryTestLayer({
							discardStaging: () => Effect.die("not used"),
							findSet: () => Effect.die("not used"),
							finalizeRun: () => Effect.die("not used"),
							listRuns: () => Effect.die("not used"),
							loadRun: () => Effect.die("not used"),
							loadSet: () => Effect.succeed(fixtureReviewSet),
							prepareRun: () => Effect.die("not used"),
							saveSet: () => Effect.die("not used"),
							storeArtifact: () => Effect.die("not used"),
							writeRunDocument: () => Effect.die("not used")
						}),
						makeReviewCaptureTestLayer({
							captureSet: () => Effect.die("capture must stay blocked during PIE")
						}),
						makeReviewAuthoringTestLayer(dyingAuthoring)
					)
				)
			)
		)
	)
);
