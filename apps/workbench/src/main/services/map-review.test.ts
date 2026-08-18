import {
	makeReviewAuthoringTestLayer,
	makeReviewAuthoringSessionsTestLayer,
	makeReviewCaptureTestLayer,
	makeReviewRepositoryTestLayer,
	makeCameraFeedTestLayer,
	decodeReviewSet,
	type ReviewAuthoringApi,
	ReviewAuthoringSessionError,
	VisibilityPolicyId,
	type ReviewAuthoringSessionsApi,
	type ReviewCaptureApi,
	type ReviewSet
} from "@ue-shed/cameras";
import { it } from "@effect/vitest";
import { Observatory, ActorId, WorldScoutRefreshRate } from "@ue-shed/observatory";
import { makeEditorPlaySessionTestLayer } from "@ue-shed/engine-discovery";
import { EditorPlaySessionId } from "@ue-shed/protocol";
import { makeAssetReaderTestLayer } from "@ue-shed/unreal-assets";
import { makeRemoteControlClientTestLayer } from "@ue-shed/unreal-connection";
import { Effect, Layer, Queue, Ref, Stream } from "effect";
import { TestClock } from "effect/testing";
import { join } from "node:path";
import { expect } from "vitest";
import { makeLocalFilesTestLayer } from "../adapters/local-files.js";
import { makeWorkbenchWindowTestLayer, WorkbenchWindowTest } from "../adapters/electron-window.js";
import {
	makeWorkbenchConfigurationLayer,
	type WorkbenchConfigurationApi
} from "../workbench-config.js";
import { WorkbenchMapReview, WorkbenchMapReviewLive } from "./map-review.js";
import { makeWorkbenchProjectTestLayer } from "./project-workspace.js";

// Map Review receives the app-wide project's cached map inventory from this focused test seam.
const mapReviewProject = {
	maps: [
		{ label: "Alpha", mapPath: "Content/Maps/L_Alpha.umap" },
		{ label: "Beta", mapPath: "Content/Maps/L_Beta.umap" }
	],
	project: {
		inputAtlas: "ready" as const,
		mapCount: 2,
		packageCount: 3,
		projectName: "MyProj",
		projectRoot: "D:/Games/MyProj"
	}
};
const projectTestLayer = makeWorkbenchProjectTestLayer({
	choose: () => Effect.succeed({ project: mapReviewProject.project, status: "ready" as const }),
	current: () => Effect.succeed({ status: "not_configured" as const }),
	inputAtlas: () => Effect.die("not used"),
	savedTables: () => Effect.die("savedTables is not used"),
	savedProject: () =>
		Effect.succeed({
			maps: mapReviewProject.maps,
			projectRoot: mapReviewProject.project.projectRoot
		})
});
const MapReviewLiveWithDialog = Layer.provide(WorkbenchMapReviewLive, projectTestLayer);

const reviewSetPath = "C:/Fixture/.ue-shed/review/sets/fixture.json";
const projectRoot = "C:/FixtureProject";

const fixtureReviewSet = Effect.runSync(
	decodeReviewSet({
		captureProfiles: [
			{
				id: "profile-1",
				imageFormat: "png",
				renderProfile: "full_fidelity",
				resolution: { height: 1080, width: 1920 },
				variantPolicy: "pure_only"
			}
		],
		contract: { name: "ue-shed-review-set", version: { major: 1, minor: 0 } },
		displayName: "Fixture Review Set",
		id: "review-set-1",
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
				captureProfileId: "profile-1",
				displayName: "Front view",
				framingRecipe: { kind: "manual", version: 1 },
				id: "view-1",
				purpose: "Establishing shot",
				subject: {
					actorPath: "/Game/Maps/Fixture.Fixture:PersistentLevel.Subject_0",
					kind: "actor_path"
				},
				tags: []
			}
		]
	})
);
const policyReviewSet = Effect.runSync(decodeReviewSet(fixtureReviewSet));

const configuredReview: WorkbenchConfigurationApi = {
	authoringAsset: { status: "not_configured" },
	expectedProject: { status: "not_configured" },
	project: { status: "not_configured" },
	remoteControlEndpoint: "http://127.0.0.1:30001",
	review: { projectRoot, reviewSetPath, status: "configured" },
	sourceCheckout: { status: "not_configured" },
	textureAuditRules: { status: "not_configured" }
};

const notConfigured: WorkbenchConfigurationApi = {
	...configuredReview,
	review: { status: "not_configured" }
};

const projectConfigured: WorkbenchConfigurationApi = {
	...configuredReview,
	review: { projectRoot, status: "project_configured" }
};

const dyingCapture: ReviewCaptureApi = { captureSet: () => Effect.die("not used") };
const dyingAuthoring: ReviewAuthoringApi = {
	inspectSelection: () => Effect.die("not used"),
	inspectSubject: () => Effect.die("not used"),
	previewCandidate: () => Effect.die("not used")
};
const clearOnlyRemoteControl = makeRemoteControlClientTestLayer((request) => {
	if (request.functionName === "EnsureProvisionedCameras") {
		return Effect.succeed({
			cameras: [],
			error: "editor-live-unavailable",
			schemaVersion: 2,
			status: "failed",
			worldContext: "editor"
		});
	}
	if (request.functionName === "ClearProvisionedCameras") {
		return Effect.succeed({ cameras: [], schemaVersion: 1 });
	}
	return Effect.die(`unexpected remote call ${request.functionName}`);
});
const dyingAuthoringSessions: ReviewAuthoringSessionsApi = {
	approve: () => Effect.die("not used"),
	create: (args) =>
		// SAFETY: this focused session mock supplies every field read by WorkbenchMapReview.
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
const assetReaderTestLayer = makeAssetReaderTestLayer({
	discoverAssets: () => Effect.die("not used"),
	discoverTables: () => Effect.die("not used"),
	readAsset: () => Effect.die("not used"),
	readTable: () => Effect.die("not used"),
	source: () => Effect.succeed("configured" as const)
});

const makeMapReviewDeps = (
	authoringSessions: ReviewAuthoringSessionsApi = dyingAuthoringSessions
) =>
	Layer.mergeAll(
		assetReaderTestLayer,
		makeCameraFeedTestLayer(),
		makeWorkbenchWindowTestLayer(),
		clearOnlyRemoteControl,
		makeReviewAuthoringSessionsTestLayer(authoringSessions),
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
	);

const baseMapReviewDeps = makeMapReviewDeps();

const WorkbenchMapReviewTestLive = MapReviewLiveWithDialog.pipe(Layer.provide(baseMapReviewDeps));

it.effect("uses the global project's cached .umap inventory for saved map review", () =>
	Effect.gen(function* () {
		const service = yield* WorkbenchMapReview;
		const choice = yield* service.chooseProjectAndMaps();
		expect(choice.status).toBe("configured");
		if (choice.status !== "configured") return;
		expect(choice.projectName).toBe("MyProj");
		// The selected project exposes its discovered maps as project-relative paths.
		expect(choice.maps.map((map) => map.mapPath)).toEqual([
			"Content/Maps/L_Alpha.umap",
			"Content/Maps/L_Beta.umap"
		]);
		// That same cached inventory backs savedWorldMaps without a second native map picker.
		const maps = yield* service.savedWorldMaps();
		expect(maps.map((map) => map.mapPath)).toEqual([
			"Content/Maps/L_Alpha.umap",
			"Content/Maps/L_Beta.umap"
		]);
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
			id: "review-set-1",
			mapPath: "/Game/Maps/Fixture",
			viewCount: 1,
			views: [
				{
					actorPath: "/Game/Maps/Fixture.Fixture:PersistentLevel.Subject_0",
					captureProfileId: "profile-1",
					displayName: "Front view",
					id: "view-1",
					resolution: { height: 1080, width: 1920 },
					revision: { id: "view-1-r1", number: 1, status: "numbered" },
					subjectLabel: "Front view",
					viewpoint: "world_fixed",
					visibilityPolicy: policyReviewSet.visibilityPolicies[0]
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
								// SAFETY: this fixture supplies the complete capture run contract used by the test.
								Effect.succeed({
									completedAt: "2026-01-01T00:00:00.000Z",
									contract: {
										name: "ue-shed-capture-run" as const,
										version: { major: 1, minor: 1 }
									},
									id: "run-1",
									invocation: {
										cause: { type: "manual" as const },
										id: "invocation-1",
										reviewSetId: fixtureReviewSet.id
									},
									project: fixtureReviewSet.project,
									results: [
										{
											artifacts: [
												{
													byteLength: 3,
													contentHash: `sha256:${"a".repeat(64)}`,
													height: 1080,
													id: "artifact-1",
													mediaType: "image/png" as const,
													relativePath: "artifact.png",
													variant: "pure" as const,
													width: 1920
												}
											],
											captureDurationMs: 10,
											resolvedActorPath:
												"/Game/Maps/Fixture.Fixture:PersistentLevel.Subject_0",
											status: "captured" as const,
											viewId: "view-1",
											viewRevision: {
												id: "view-1-r1",
												number: 1,
												status: "numbered" as const
											},
											visibility: {
												reason: "Fixture has no visibility assessment.",
												status: "not_assessed" as const
											}
										}
									],
									reviewSetId: fixtureReviewSet.id,
									startedAt: "2026-01-01T00:00:00.000Z",
									status: "completed" as const
								} as never),
							loadSet: () => Effect.succeed(policyReviewSet),
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

it.effect("lists, switches, and creates project Review Sets without changing the map", () => {
	const lightingPath = "C:/FixtureProject/.ue-shed/review/sets/lighting.json";
	const lightingSet = Effect.runSync(
		decodeReviewSet({
			...fixtureReviewSet,
			displayName: "Lighting review",
			id: "lighting-review",
			views: []
		})
	);
	const stored = new Map<string, ReviewSet>([
		[reviewSetPath, policyReviewSet],
		[lightingPath, lightingSet]
	]);

	return Effect.gen(function* () {
		const service = yield* WorkbenchMapReview;
		const library = yield* service.reviewSetLibrary();
		expect(library).toEqual({
			activeReviewSetId: "review-set-1",
			sets: [
				{
					displayName: "Fixture Review Set",
					id: "review-set-1",
					mapPath: "/Game/Maps/Fixture",
					viewCount: 1
				},
				{
					displayName: "Lighting review",
					id: "lighting-review",
					mapPath: "/Game/Maps/Fixture",
					viewCount: 0
				}
			],
			status: "ready"
		});

		const selected = yield* service.selectReviewSet({ reviewSetId: "lighting-review" });
		expect(selected.status).toBe("ready");
		if (selected.status !== "ready") return;
		expect(selected.reviewSet.id).toBe("lighting-review");

		const created = yield* service.createReviewSet({ displayName: "Facade pass" });
		expect(created.status).toBe("ready");
		if (created.status !== "ready") return;
		expect(created.reviewSet.displayName).toBe("Facade pass");
		expect(created.reviewSet.id).toMatch(/^facade-pass-/);
		expect(created.reviewSet.mapPath).toBe("/Game/Maps/Fixture");
		expect(created.reviewSet.views).toEqual([]);
		expect([...stored.values()].find((set) => set.id === created.reviewSet.id)?.views).toEqual(
			[]
		);
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
							listRuns: () => Effect.succeed([]),
							listSets: () =>
								Effect.sync(() =>
									[...stored.entries()].map(([path, reviewSet]) => ({
										displayName: reviewSet.displayName,
										id: reviewSet.id,
										mapPath: reviewSet.project.mapPath,
										path,
										viewCount: reviewSet.views.length
									}))
								),
							loadRun: () => Effect.die("not used"),
							loadSet: (path) =>
								Effect.sync(() => {
									const reviewSet = stored.get(path);
									if (reviewSet === undefined)
										throw new Error(`Unknown set ${path}`);
									return reviewSet;
								}),
							prepareRun: () => Effect.die("not used"),
							saveSet: ({ path, reviewSet }) =>
								Effect.sync(() => void stored.set(path, reviewSet)),
							storeArtifact: () => Effect.die("not used"),
							writeRunDocument: () => Effect.die("not used")
						}),
						makeReviewCaptureTestLayer(dyingCapture),
						makeReviewAuthoringTestLayer(dyingAuthoring)
					)
				)
			)
		)
	);
});

it.effect("round-trips immutable policy replacement through the headless service", () => {
	let stored = policyReviewSet;
	return Effect.gen(function* () {
		const service = yield* WorkbenchMapReview;
		const result = yield* service.replaceVisibilityPolicy({
			policy: {
				assessment: { method: "depth_compare" },
				id: VisibilityPolicyId.make("clear-v2"),
				name: "Clear v2",
				onLowVisibility: { action: "warn", threshold: 0.5 },
				output: {
					clearStrategy: { type: "isolate_target" },
					mode: "natural_and_clear"
				}
			},
			viewId: "view-1"
		});
		expect(result.status).toBe("ready");
		expect(stored.visibilityPolicies.map((policy) => policy.id)).toEqual([
			"default-natural-only",
			"clear-v2"
		]);
		expect(stored.views[0]?.visibilityPolicyId).toBe("clear-v2");
	}).pipe(
		Effect.provide(
			WorkbenchMapReviewTestLive.pipe(
				Layer.provide(
					Layer.mergeAll(
						makeWorkbenchConfigurationLayer(configuredReview),
						makeLocalFilesTestLayer(),
						makeReviewRepositoryTestLayer({
							discardStaging: () => Effect.die("not used"),
							findSet: () => Effect.succeed(stored),
							finalizeRun: () => Effect.die("not used"),
							listRuns: () => Effect.succeed([]),
							loadRun: () => Effect.die("not used"),
							loadSet: () => Effect.succeed(stored),
							prepareRun: () => Effect.die("not used"),
							saveSet: ({ reviewSet }) =>
								Effect.sync(() => void (stored = reviewSet)),
							storeArtifact: () => Effect.die("not used"),
							writeRunDocument: () => Effect.die("not used")
						}),
						makeReviewCaptureTestLayer(dyingCapture),
						makeReviewAuthoringTestLayer(dyingAuthoring)
					)
				)
			)
		)
	);
});

it.effect("reports an actionable map mismatch before starting authoring", () =>
	Effect.gen(function* () {
		const service = yield* WorkbenchMapReview;
		const result = yield* service.authorFromSelection({
			destination: { kind: "append_view" }
		});
		expect(result.status).toBe("map_mismatch");
		if (result.status === "map_mismatch") {
			expect(result.reviewSet.mapPath).toBe("/Game/Maps/Fixture");
			expect(result.selection.mapPath).toBe("/Game/Maps/Other");
			expect(result.recovery).toContain("selected map");
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
							listSets: () => Effect.succeed([]),
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

it.effect("does not carry the startup Review Set into a newly selected project", () => {
	let startArgs: Parameters<ReviewAuthoringSessionsApi["start"]>[0] | undefined;
	const selectedProjectRoot = "D:/Games/Hex";
	const selectedProjectLayer = makeWorkbenchProjectTestLayer({
		choose: () => Effect.die("not used"),
		current: () =>
			Effect.succeed({
				project: { ...mapReviewProject.project, projectRoot: selectedProjectRoot },
				status: "ready" as const
			}),
		inputAtlas: () => Effect.die("not used"),
		savedTables: () => Effect.die("not used"),
		savedProject: () => Effect.die("not used")
	});
	const sessions: ReviewAuthoringSessionsApi = {
		...dyingAuthoringSessions,
		start: (args) => {
			startArgs = args;
			return dyingAuthoringSessions.create({
				candidates: args.candidates,
				projectRoot: args.projectRoot,
				reviewSetPath: `${selectedProjectRoot}/.ue-shed/review/sets/hex.json`,
				selection: args.selection,
				viewId: "hex-subject"
			});
		}
	};
	const live = WorkbenchMapReviewLive.pipe(
		Layer.provide(selectedProjectLayer),
		Layer.provide(makeMapReviewDeps(sessions))
	);

	return Effect.gen(function* () {
		const service = yield* WorkbenchMapReview;
		const result = yield* service.authorFromSelection({
			destination: { kind: "append_view" }
		});

		expect(result.status).toBe("ready");
		expect(startArgs?.projectRoot).toBe(selectedProjectRoot);
		expect(startArgs?.reviewSetPath).toBeUndefined();
		expect(startArgs?.selection.mapPath).toBe("/Game/Hex/L_Hex");
	}).pipe(
		Effect.provide(
			live.pipe(
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
							loadSet: () => Effect.die("not used"),
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
									actorPath: "/Game/Hex/L_Hex.L_Hex:PersistentLevel.Subject",
									bounds: {
										center: { x: 0, y: 0, z: 0 },
										extent: { x: 100, y: 100, z: 100 },
										rotation: { pitch: 0, roll: 0, yaw: 0 }
									},
									contract: {
										name: "ue-shed-review-selection" as const,
										version: { major: 1, minor: 0 }
									},
									displayName: "Hex Subject",
									mapPath: "/Game/Hex/L_Hex",
									status: "selected" as const
								})
						})
					)
				)
			)
		)
	);
});

it.effect("generates framing candidates for a matching selection", () =>
	Effect.gen(function* () {
		const service = yield* WorkbenchMapReview;
		const result = yield* service.authorFromSelection({
			destination: { kind: "append_view" }
		});
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
				MapReviewLiveWithDialog.pipe(
					Layer.provide(
						Layer.mergeAll(
							assetReaderTestLayer,
							makeCameraFeedTestLayer(),
							makeWorkbenchWindowTestLayer(),
							clearOnlyRemoteControl,
							makeReviewAuthoringSessionsTestLayer({
								...dyingAuthoringSessions,
								load: () =>
									// SAFETY: this fixture supplies the complete persisted session used by reframe.
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
									// SAFETY: this mock returns every active-session field consumed by the service.
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
									// SAFETY: this ready subject fixture contains every field consumed by the service.
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
			MapReviewLiveWithDialog.pipe(
				Layer.provide(
					Layer.mergeAll(
						assetReaderTestLayer,
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
							// SAFETY: durableAuthoringSession is a complete test-owned persisted session fixture.
							latest: () => Effect.succeed(durableAuthoringSession as never),
							resume: () =>
								Effect.succeed({
									// SAFETY: the same persisted fixture is the resumable session returned by this mock.
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
			MapReviewLiveWithDialog.pipe(
				Layer.provide(
					Layer.mergeAll(
						assetReaderTestLayer,
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
									// SAFETY: lifecycle is deliberately changed on a complete session fixture.
									session: {
										...durableAuthoringSession,
										lifecycle: "stale" as const
									} as never,
									status: "stale" as const
								}),
							load: () =>
								// SAFETY: lifecycle is deliberately changed on a complete session fixture.
								Effect.succeed({
									...durableAuthoringSession,
									lifecycle: "stale" as const
								} as never),
							resume: () =>
								Effect.succeed({
									reasons: ["bounds_changed" as const],
									recovery: staleRecoveryGuidance,
									// SAFETY: lifecycle is deliberately changed on a complete session fixture.
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
		const serviceLayer = MapReviewLiveWithDialog.pipe(
			Layer.provide(
				Layer.mergeAll(
					assetReaderTestLayer,
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
					// SAFETY: this channel's payload is encoded by RendererWorldObservationEvent.
					(entry.payload as { kind: string }).kind === "catalog"
			);
			const transformEvents = afterTransforms.filter(
				(entry) =>
					entry.channel === "map-review:world-observation" &&
					// SAFETY: this channel's payload is encoded by RendererWorldObservationEvent.
					(entry.payload as { kind: string }).kind === "transforms"
			);
			expect(catalogEventIndex).toBeGreaterThanOrEqual(0);
			expect(transformEvents.length).toBeGreaterThanOrEqual(1);
			// SAFETY: transformEvents was filtered to the transforms payload variant above.
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
		const serviceLayer = MapReviewLiveWithDialog.pipe(
			Layer.provide(
				Layer.mergeAll(
					assetReaderTestLayer,
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
						// SAFETY: this channel's payload is encoded by RendererWorldObservationEvent.
						(entry.payload as { kind: string; status?: string }).kind === "catalog" &&
						// SAFETY: this is the same catalog payload narrowed on the preceding line.
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
	draftPose: {
		aspectRatio: "16:9" as const,
		fieldOfViewDegrees: 55,
		location: { x: 40, y: 50, z: 60 },
		projection: "perspective" as const,
		rotation: { pitch: -8, roll: 0, yaw: 90 }
	},
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
	updatedAt: "2026-07-20T00:00:00.000Z",
	viewId: "initial-view"
};

function makeLivePreviewServiceLayer(worldContext: "editor" | "play") {
	return MapReviewLiveWithDialog.pipe(
		Layer.provide(
			Layer.mergeAll(
				assetReaderTestLayer,
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
					if (request.functionName === "EnsureProvisionedCameras") {
						// SAFETY: WorkbenchMapReview just serialized this private provisioning request.
						const provisioned = JSON.parse(String(request.parameters.RequestJson)) as {
							cameras: Array<{ location: unknown; projection: unknown }>;
						};
						expect(provisioned.cameras[0]).toMatchObject({
							location: { x: 40, y: 50, z: 60 },
							projection: { fieldOfViewDegrees: 55, type: "perspective" }
						});
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
							schemaVersion: 2,
							worldContext
						});
					}
					if (request.functionName === "ClearProvisionedCameras") {
						return Effect.succeed({ cameras: [], schemaVersion: 2, worldContext });
					}
					return Effect.die(`unexpected remote call ${request.functionName}`);
				}),
				makeReviewAuthoringSessionsTestLayer({
					...dyingAuthoringSessions,
					// SAFETY: livePreviewSession is a complete test-owned session fixture.
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
							state:
								worldContext === "play"
									? {
											mode: "play" as const,
											sessionId: EditorPlaySessionId.make("pie-1"),
											status: "running" as const
										}
									: { status: "stopped" as const }
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
					previewCandidate: () => Effect.die("PNG fallback must not run")
				})
			)
		)
	);
}

function expectLiveDraftPreview(previewContext: "editor_live" | "play_live") {
	return Effect.gen(function* () {
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
			previewContext,
			status: "ready",
			width: 320
		});
	});
}

it.effect("streams the selected draft pose from the editor world while stopped", () =>
	expectLiveDraftPreview("editor_live").pipe(
		Effect.provide(makeLivePreviewServiceLayer("editor"))
	)
);

it.effect("streams the selected draft pose from the play world while PIE is running", () =>
	expectLiveDraftPreview("play_live").pipe(Effect.provide(makeLivePreviewServiceLayer("play")))
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
			MapReviewLiveWithDialog.pipe(
				Layer.provide(
					Layer.mergeAll(
						assetReaderTestLayer,
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
										sessionId: EditorPlaySessionId.make("pie-1"),
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
