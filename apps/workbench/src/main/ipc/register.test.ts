import { it } from "@effect/vitest";
import { aggregateHealth, defaultHealthInput } from "@ue-shed/observability";
import type { TextureAuditRunResult, TexturePreviewResult } from "@ue-shed/asset-audits";
import type { MapReviewApprovalResult } from "@ue-shed/cameras/review-contracts";
import type { EnhancedInputRunResult } from "@ue-shed/enhanced-input";
import type { TextCorpusRunResult } from "@ue-shed/game-text";
import type { CameraScheduleConfig, CameraStatus } from "@ue-shed/protocol";
import { makeEditorPlaySessionTestLayer } from "@ue-shed/engine-discovery";
import {
	makeScenarioRunnerTestLayer,
	movementGymRuns,
	movementGymScenario,
	ScenarioRunHandle,
	scenarioWireContract,
	type ScenarioRunnerShape
} from "@ue-shed/scenarios";
import { Effect, Layer, Ref } from "effect";
import { expect } from "vitest";
import { ElectronIpcTest, makeElectronIpcTestLayer } from "../adapters/electron-ipc.js";
import { invokeChannelNames } from "../ipc-contracts.js";
import { makeWorkbenchAssetAuditsTestLayer } from "../services/asset-audits.js";
import { makeWorkbenchAssetNavigationTestLayer } from "../services/asset-navigation.js";
import { makeWorkbenchAuthoringTestLayer } from "../services/authoring.js";
import { makeCameraPresentationTestLayer } from "../services/camera-presentation.js";
import { makeWorkbenchContentObservatoryTestLayer } from "../services/content-observatory.js";
import { makeWorkbenchConfigExplorerTestLayer } from "../services/config-explorer.js";
import { makeFixtureLauncherTestLayer } from "../services/fixture-launcher.js";
import { makeWorkbenchGameTextTestLayer } from "../services/game-text.js";
import { makeWorkbenchInputAtlasTestLayer } from "../services/input-atlas.js";
import { makeWorkbenchMapReviewTestLayer } from "../services/map-review.js";
import { makeWorkbenchMapCaptureTestLayer } from "../services/map-capture.js";
import { makeProjectLauncherTestLayer } from "../services/project-launcher.js";
import { makeWorkbenchProjectTestLayer } from "../services/project-workspace.js";
import { makeShowcaseTestLayer } from "../services/showcase.js";
import { makeWorkbenchUnrealConnectionLayer } from "../services/unreal-connection.js";
import { makeWorkbenchConfigurationLayer } from "../workbench-config.js";
import { register } from "./register.js";

function makeRecorder() {
	return Effect.map(Ref.make<ReadonlyArray<string>>([]), (log) => ({
		calls: () => Ref.get(log),
		record: (event: string) => Ref.update(log, (entries) => [...entries, event])
	}));
}
type Recorder = Effect.Success<ReturnType<typeof makeRecorder>>;

const sampleCameraScheduleConfig: CameraScheduleConfig = {
	activeCameraCount: 4,
	backgroundFps: 1,
	captureBudgetPerTick: 4,
	focusedCameraIndex: null,
	focusedFps: 30,
	paused: false,
	pipelineMode: "full_pipeline",
	renderProfile: "observation",
	resolution: "640x360",
	viewMode: "overview"
};

const sampleCameraStatus: CameraStatus = {
	cameras: [],
	config: sampleCameraScheduleConfig,
	pipeName: "ue-shed-cameras",
	schemaVersion: 1,
	stats: {
		bytesSent: 0,
		captureBatchesSubmitted: 0,
		cadenceIntervalsSkipped: 0,
		camerasDue: 0,
		capturesRequested: 0,
		experimentBytesSent: 0,
		experimentCadenceIntervalsSkipped: 0,
		experimentElapsedMs: 0,
		experimentFramesDelivered: 0,
		experimentReadbackDrops: 0,
		experimentReadbackResourcesCreated: 0,
		experimentReadbacksEnqueued: 0,
		experimentRenderedCaptures: 0,
		experimentRevision: 0,
		experimentSchedulerTicks: 0,
		experimentScheduledCaptures: 0,
		experimentTransportReplacements: 0,
		framesDelivered: 0,
		lastCaptureBatchSize: 0,
		lastCaptureBatchSubmissionMs: 0,
		maxCaptureBatchSize: 0,
		maxCaptureBatchSubmissionMs: 0,
		maxCaptureLatenessMs: 0,
		pipeConnected: false,
		readbackDrops: 0,
		readbackResourcesCreated: 0,
		schedulerTicks: 0,
		totalCaptureBatchSubmissionMs: 0,
		totalCaptureLatenessMs: 0,
		transportReplacements: 0
	}
};

/** Builds the full fake feature-service graph that `register.ts` depends on. */
function buildRegistrationLayer(recorder: Recorder) {
	const showcase = makeShowcaseTestLayer({
		context: () =>
			recorder.record("showcase.context").pipe(
				Effect.as({
					fixtureConfigured: false,
					health: aggregateHealth(defaultHealthInput),
					project: { status: "not_configured" as const },
					reader: "configured" as const
				})
			)
	});

	const assetAudits = makeWorkbenchAssetAuditsTestLayer({
		chooseAndScan: () =>
			recorder
				.record("assetAudits.chooseAndScan")
				.pipe(Effect.as({ status: "not_configured" } as TextureAuditRunResult)),
		configuredScan: () =>
			recorder
				.record("assetAudits.configuredScan")
				.pipe(Effect.as({ status: "not_configured" } as TextureAuditRunResult)),
		preview: (objectPath) =>
			recorder.record(`assetAudits.preview:${objectPath}`).pipe(
				Effect.as({
					contract: { name: "texture-preview", version: { major: 1, minor: 0 } },
					message: "unavailable",
					objectPath,
					reason: "not_connected",
					retrySafe: true,
					status: "unavailable"
				} as TexturePreviewResult)
			),
		previewOffline: (objectPath) =>
			recorder.record(`assetAudits.previewOffline:${objectPath}`).pipe(
				Effect.as({
					contract: { name: "texture-preview", version: { major: 1, minor: 0 } },
					message: "unavailable",
					objectPath,
					reason: "offline_unavailable",
					retrySafe: true,
					status: "unavailable"
				} as TexturePreviewResult)
			),
		previewOfflineBatch: (request) =>
			recorder
				.record(`assetAudits.previewOfflineBatch:${request.objectPaths.join(",")}`)
				.pipe(
					Effect.as({
						cached: 0,
						generated: request.objectPaths.length,
						previews: request.objectPaths.map(
							(objectPath) =>
								({
									contract: {
										name: "texture-preview",
										version: { major: 1, minor: 0 }
									},
									message: "unavailable",
									objectPath,
									reason: "offline_unavailable",
									retrySafe: true,
									status: "unavailable"
								}) as TexturePreviewResult
						)
					})
				)
	});
	const assetNavigation = makeWorkbenchAssetNavigationTestLayer({
		locate: (objectPath) =>
			recorder.record(`assetNavigation.locate:${objectPath}`).pipe(
				Effect.as({
					contract: {
						name: "unreal-editor-asset-navigation" as const,
						version: { major: 1 as const, minor: 0 as const }
					},
					objectPath,
					status: "located" as const
				})
			)
	});

	const gameText = makeWorkbenchGameTextTestLayer({
		chooseAndScan: () =>
			recorder
				.record("gameText.chooseAndScan")
				.pipe(Effect.as({ status: "not_configured" } as TextCorpusRunResult)),
		configuredScan: () =>
			recorder
				.record("gameText.configuredScan")
				.pipe(Effect.as({ status: "not_configured" } as TextCorpusRunResult))
	});

	const contentObservatory = makeWorkbenchContentObservatoryTestLayer({
		cancel: () =>
			recorder
				.record("contentObservatory.cancel")
				.pipe(Effect.as({ status: "not_configured" as const })),
		start: (request) =>
			recorder
				.record(`contentObservatory.start:${request.mapPath}`)
				.pipe(Effect.as({ status: "not_configured" as const })),
		status: () =>
			recorder
				.record("contentObservatory.status")
				.pipe(Effect.as({ status: "not_configured" as const })),
		targets: () => Effect.die("target discovery is not used by this registration test")
	});

	const inputAtlas = makeWorkbenchInputAtlasTestLayer({
		chooseAndScan: () =>
			recorder
				.record("inputAtlas.chooseAndScan")
				.pipe(Effect.as({ status: "not_configured" } as EnhancedInputRunResult)),
		configuredScan: () =>
			recorder
				.record("inputAtlas.configuredScan")
				.pipe(Effect.as({ status: "not_configured" } as EnhancedInputRunResult))
	});
	const configExplorer = makeWorkbenchConfigExplorerTestLayer({
		query: (request) =>
			recorder.record(`configExplorer.query:${request.key}`).pipe(
				Effect.as({
					error: {
						code: "sample_unavailable" as const,
						message: "Fixture unavailable.",
						recovery: "Launch through pnpm showcase.",
						retrySafe: false
					},
					status: "failed" as const
				})
			)
	});

	const project = makeWorkbenchProjectTestLayer({
		choose: () =>
			recorder.record("project.choose").pipe(Effect.as({ status: "cancelled" as const })),
		current: () =>
			recorder
				.record("project.current")
				.pipe(Effect.as({ status: "not_configured" as const })),
		inputAtlas: () => Effect.die("not used"),
		savedTables: () => Effect.die("savedTables is not used"),
		savedProject: () => Effect.die("not used")
	});

	const sessionFailure = {
		status: "failed" as const,
		error: { code: "test", message: "m", recovery: "r", retrySafe: false }
	};

	const authoring = makeWorkbenchAuthoringTestLayer({
		applySession: (sessionId) =>
			recorder.record(`authoring.applySession:${sessionId}`).pipe(Effect.as(sessionFailure)),
		beginSession: (objectPath) =>
			recorder.record(`authoring.beginSession:${objectPath}`).pipe(Effect.as(sessionFailure)),
		discardSession: (sessionId) =>
			recorder
				.record(`authoring.discardSession:${sessionId}`)
				.pipe(Effect.as({ diagnostics: [], sessions: [], status: "ready" as const })),
		chooseTable: () =>
			recorder
				.record("authoring.chooseTable")
				.pipe(Effect.as({ status: "not_configured" as const })),
		configuredCatalog: () =>
			recorder
				.record("authoring.configuredCatalog")
				.pipe(Effect.as({ status: "not_configured" as const })),
		configuredTable: () =>
			recorder
				.record("authoring.configuredTable")
				.pipe(Effect.as({ status: "not_configured" as const })),
		editSession: (intent) =>
			recorder
				.record(`authoring.editSession:${intent.sessionId}`)
				.pipe(Effect.as(sessionFailure)),
		listSessions: () =>
			recorder
				.record("authoring.listSessions")
				.pipe(Effect.as({ diagnostics: [], sessions: [], status: "ready" as const })),
		openCatalogTable: (objectPath) =>
			recorder
				.record(`authoring.openCatalogTable:${objectPath}`)
				.pipe(Effect.as({ status: "not_configured" as const })),
		openSession: (sessionId) =>
			recorder.record(`authoring.openSession:${sessionId}`).pipe(Effect.as(sessionFailure)),
		reconcileSession: (sessionId) =>
			recorder
				.record(`authoring.reconcileSession:${sessionId}`)
				.pipe(Effect.as(sessionFailure)),
		redoSession: (sessionId) =>
			recorder.record(`authoring.redoSession:${sessionId}`).pipe(Effect.as(sessionFailure)),
		reviewSession: (sessionId) =>
			recorder.record(`authoring.reviewSession:${sessionId}`).pipe(Effect.as(sessionFailure)),
		saveSession: (sessionId) =>
			recorder.record(`authoring.saveSession:${sessionId}`).pipe(Effect.as(sessionFailure)),
		undoSession: (sessionId) =>
			recorder.record(`authoring.undoSession:${sessionId}`).pipe(Effect.as(sessionFailure))
	});

	const mapReview = makeWorkbenchMapReviewTestLayer({
		worldSnapshot: () =>
			recorder.record("mapReview.worldSnapshot").pipe(
				Effect.as({
					message: "offline",
					recovery: "open Unreal",
					status: "unavailable" as const
				})
			),
		focusActor: (actorId) =>
			recorder
				.record(`mapReview.focusActor:${actorId}`)
				.pipe(Effect.as({ actorId, status: "not_supported" as const })),
		approveCandidate: (intent) =>
			recorder.record(`mapReview.approveCandidate:${intent.candidateId}`).pipe(
				Effect.as({
					status: "failed",
					error: { message: "m", recovery: "r" }
				} as MapReviewApprovalResult)
			),
		authorFromSelection: () =>
			recorder
				.record("mapReview.authorFromSelection")
				.pipe(
					Effect.as({ status: "failed" as const, error: { message: "m", recovery: "r" } })
				),
		authoringPatch: () =>
			recorder
				.record("mapReview.authoringPatch")
				.pipe(
					Effect.as({ status: "failed" as const, error: { message: "m", recovery: "r" } })
				),
		authoringReframe: () =>
			recorder
				.record("mapReview.authoringReframe")
				.pipe(
					Effect.as({ status: "failed" as const, error: { message: "m", recovery: "r" } })
				),
		authoringResume: () =>
			recorder
				.record("mapReview.authoringResume")
				.pipe(
					Effect.as({ status: "failed" as const, error: { message: "m", recovery: "r" } })
				),
		capture: () =>
			recorder
				.record("mapReview.capture")
				.pipe(Effect.as({ status: "not_configured" as const })),
		discardAuthoring: () =>
			recorder
				.record("mapReview.discardAuthoring")
				.pipe(
					Effect.as({ status: "failed" as const, error: { message: "m", recovery: "r" } })
				),
		approveAuthoring: () =>
			recorder
				.record("mapReview.approveAuthoring")
				.pipe(
					Effect.as({ status: "failed" as const, error: { message: "m", recovery: "r" } })
				),
		load: () =>
			recorder
				.record("mapReview.load")
				.pipe(Effect.as({ status: "not_configured" as const })),
		previewCandidate: (candidateId) =>
			recorder
				.record(`mapReview.previewCandidate:${candidateId}`)
				.pipe(
					Effect.as({ status: "failed" as const, error: { message: "m", recovery: "r" } })
				),
		previewAuthoringCandidate: () =>
			recorder
				.record("mapReview.previewAuthoringCandidate")
				.pipe(
					Effect.as({ status: "failed" as const, error: { message: "m", recovery: "r" } })
				),
		setLivePreviewFps: (fps) =>
			recorder.record(`mapReview.setLivePreviewFps:${fps}`).pipe(Effect.as(fps)),
		setWorldObservationRate: (cadenceHz) =>
			recorder
				.record(`mapReview.setWorldObservationRate:${cadenceHz}`)
				.pipe(Effect.as(cadenceHz)),
		subscribeWorldObservations: (cadenceHz) =>
			recorder
				.record(`mapReview.subscribeWorldObservations:${cadenceHz}`)
				.pipe(Effect.asVoid),
		unsubscribeWorldObservations: () =>
			recorder.record("mapReview.unsubscribeWorldObservations").pipe(Effect.asVoid),
		worldObservationPresentationReplacements: () => Effect.succeed(0)
	});
	const mapCapture = makeWorkbenchMapCaptureTestLayer({
		capture: () =>
			recorder.record("mapCapture.capture").pipe(
				Effect.as({
					message: "Capture fixture is not configured.",
					recovery: "Choose a plan.",
					status: "failed" as const
				})
			),
		choosePlan: () =>
			recorder
				.record("mapCapture.choosePlan")
				.pipe(Effect.as({ status: "cancelled" as const })),
		newPlan: () =>
			recorder.record("mapCapture.newPlan").pipe(Effect.as({ status: "cancelled" as const })),
		openMap: () =>
			recorder.record("mapCapture.openMap").pipe(
				Effect.as({
					message: "Editor fixture is not configured.",
					recovery: "Connect Unreal.",
					status: "failed" as const
				})
			),
		savePlan: () =>
			recorder.record("mapCapture.savePlan").pipe(Effect.as({ status: "cancelled" as const }))
	});

	const fixtureLauncher = makeFixtureLauncherTestLayer({
		launch: (mode) =>
			recorder
				.record(`fixtureLauncher.launch:${mode}`)
				.pipe(Effect.as({ status: "ready" as const }))
	});
	const projectLauncher = makeProjectLauncherTestLayer({
		launch: (mode) =>
			recorder
				.record(`projectLauncher.launch:${mode}`)
				.pipe(Effect.as({ mode, status: "launched" as const }))
	});

	const cameraPresentation = makeCameraPresentationTestLayer({
		configure: (config) =>
			recorder
				.record(`cameraPresentation.configure:${config.activeCameraCount}`)
				.pipe(Effect.as(sampleCameraStatus)),
		metrics: () =>
			recorder.record("cameraPresentation.metrics").pipe(
				Effect.as({
					bytesReceived: 0,
					deliveryReplacements: 0,
					electronPrivateMemoryMb: 0,
					framesReceived: 0,
					gpuProcessPrivateMemoryMb: 0,
					malformedFrames: 0,
					presentationBudgetMbPerSecond: 80,
					presentationFramesSent: 0,
					presentationReplacements: 0,
					receiverReplacements: 0,
					startedMonotonicMs: 0,
					transportErrors: 0
				})
			),
		setPresentationBudget: (megabytesPerSecond) =>
			recorder
				.record(`cameraPresentation.setPresentationBudget:${megabytesPerSecond}`)
				.pipe(Effect.as(megabytesPerSecond)),
		status: () =>
			recorder.record("cameraPresentation.status").pipe(Effect.as(sampleCameraStatus))
	});
	const editorSession = makeEditorPlaySessionTestLayer({
		execute: (_endpoint, command) =>
			recorder.record(`editorSession.execute:${command}`).pipe(
				Effect.as({
					command,
					contract: {
						name: "unreal-editor-play-session" as const,
						version: { major: 1 as const, minor: 0 as const }
					},
					outcome: "accepted" as const,
					state: { status: "stopped" as const }
				})
			),
		pause: () => Effect.die("not used"),
		resume: () => Effect.die("not used"),
		start: () => Effect.die("not used"),
		status: () =>
			recorder.record("editorSession.status").pipe(
				Effect.as({
					contract: {
						name: "unreal-editor-play-session" as const,
						version: { major: 1 as const, minor: 0 as const }
					},
					state: { status: "stopped" as const }
				})
			),
		stop: () => Effect.die("not used")
	});
	const scenarioHandle = ScenarioRunHandle.make({
		endpoint: "http://127.0.0.1:30001",
		evidenceLimit: 8,
		objectPath: "/Script/Fixture.Scenarios",
		pieSessionId: "pie-session-1",
		runId: "run-live-1",
		scenarioId: movementGymScenario.id
	});
	const scenarioRunner: ScenarioRunnerShape = {
		cancel: () => Effect.die("not used"),
		cancelHandle: () =>
			recorder.record("scenarioRunner.cancel").pipe(
				Effect.as({
					_tag: "Accepted" as const,
					contract: scenarioWireContract,
					runId: scenarioHandle.runId
				})
			),
		run: () => Effect.die("not used"),
		start: () => recorder.record("scenarioRunner.start").pipe(Effect.as(scenarioHandle)),
		status: () =>
			recorder.record("scenarioRunner.status").pipe(
				Effect.as({
					_tag: "Terminal" as const,
					contract: scenarioWireContract,
					result: movementGymRuns[1]!
				})
			)
	};
	const configuration = makeWorkbenchConfigurationLayer({
		authoringAsset: { status: "not_configured" },
		expectedProject: { status: "not_configured" },
		project: { status: "not_configured" },
		remoteControlEndpoint: "http://127.0.0.1:30001",
		review: { status: "not_configured" },
		sourceCheckout: { status: "not_configured" },
		textureAuditRules: { status: "not_configured" }
	});

	return Layer.mergeAll(
		showcase,
		assetAudits,
		assetNavigation,
		gameText,
		contentObservatory,
		configExplorer,
		inputAtlas,
		project,
		authoring,
		mapReview,
		mapCapture,
		fixtureLauncher,
		projectLauncher,
		cameraPresentation,
		editorSession,
		makeScenarioRunnerTestLayer(scenarioRunner),
		makeWorkbenchUnrealConnectionLayer("http://127.0.0.1:30001"),
		configuration
	);
}

function runRegistered<A>(
	body: (ipc: {
		readonly handlers: () => Effect.Effect<ReadonlyArray<{ readonly channel: string }>>;
		readonly invoke: (
			channel: string,
			...args: ReadonlyArray<unknown>
		) => Effect.Effect<unknown, unknown>;
	}) => Effect.Effect<A, unknown>
) {
	return Effect.gen(function* () {
		const recorder = yield* makeRecorder();
		const ipcTest = yield* Effect.provide(
			Effect.gen(function* () {
				yield* register;
				return yield* ElectronIpcTest;
			}),
			Layer.mergeAll(makeElectronIpcTestLayer(), buildRegistrationLayer(recorder))
		);
		const result = yield* body(ipcTest);
		return { recorder, result };
	}).pipe(Effect.scoped);
}

it.effect("registers exactly the 93 contract channels", () =>
	Effect.gen(function* () {
		const { result } = yield* runRegistered((ipc) => ipc.handlers());
		expect(result.map((entry) => entry.channel).toSorted()).toEqual(
			[...invokeChannelNames].toSorted()
		);
		expect(result).toHaveLength(93);
	})
);

it.effect("changes the Remote Control monitor port through editor-session settings", () =>
	Effect.gen(function* () {
		const { result } = yield* runRegistered((ipc) =>
			Effect.gen(function* () {
				expect(yield* ipc.invoke("editor-session:settings")).toEqual({ port: 30001 });
				return yield* ipc.invoke("editor-session:set-port", 31001);
			})
		);
		expect(result).toEqual({ port: 31001 });
	})
);

it.effect("routes Scenario Studio through the public scenario runner", () =>
	Effect.gen(function* () {
		const { recorder, result } = yield* runRegistered((ipc) =>
			Effect.gen(function* () {
				const handle = yield* ipc.invoke(
					"scenario:start",
					movementGymScenario,
					"http://127.0.0.1:30001"
				);
				yield* ipc.invoke("scenario:status", handle);
				return yield* ipc.invoke("scenario:cancel", handle);
			})
		);
		expect(result).toEqual(movementGymRuns[1]);
		expect(yield* recorder.calls()).toEqual([
			"scenarioRunner.start",
			"scenarioRunner.status",
			"scenarioRunner.cancel",
			"scenarioRunner.status"
		]);
	})
);

it.effect("dispatches fixture:launch and fixture:launch-review to FixtureLauncher.launch", () =>
	Effect.gen(function* () {
		const { recorder } = yield* runRegistered((ipc) =>
			Effect.gen(function* () {
				yield* ipc.invoke("fixture:launch");
				yield* ipc.invoke("fixture:launch-review");
			})
		);
		expect(yield* recorder.calls()).toEqual([
			"fixtureLauncher.launch:default",
			"fixtureLauncher.launch:authoring"
		]);
	})
);

it.effect("dispatches project:launch with the selected explicit mode", () =>
	Effect.gen(function* () {
		const { recorder, result } = yield* runRegistered((ipc) =>
			ipc.invoke("project:launch", "ue_shed")
		);
		expect(result).toEqual({ mode: "ue_shed", status: "launched" });
		expect(yield* recorder.calls()).toEqual(["projectLauncher.launch:ue_shed"]);
	})
);

it.effect("dispatches showcase:context to Showcase.context", () =>
	Effect.gen(function* () {
		const { recorder } = yield* runRegistered((ipc) => ipc.invoke("showcase:context"));
		expect(yield* recorder.calls()).toEqual(["showcase.context"]);
	})
);

it.effect("dispatches config-explorer:query to WorkbenchConfigExplorer", () =>
	Effect.gen(function* () {
		const { recorder, result } = yield* runRegistered((ipc) =>
			ipc.invoke("config-explorer:query", {
				family: "Game",
				key: "Entries",
				mode: "explain",
				platform: "PlatformA",
				section: "Fixture.Settings",
				source: "sample_fixture"
			})
		);
		expect(result).toEqual({
			error: {
				code: "sample_unavailable",
				message: "Fixture unavailable.",
				recovery: "Launch through pnpm showcase.",
				retrySafe: false
			},
			status: "failed"
		});
		expect(yield* recorder.calls()).toEqual(["configExplorer.query:Entries"]);
	})
);

it.effect("dispatches generic asset navigation with a decoded object path", () =>
	Effect.gen(function* () {
		const { recorder, result } = yield* runRegistered((ipc) =>
			ipc.invoke("asset-navigation:locate", "/Game/Textures/T_Rock.T_Rock")
		);
		expect(result).toEqual({
			contract: {
				name: "unreal-editor-asset-navigation",
				version: { major: 1, minor: 0 }
			},
			objectPath: "/Game/Textures/T_Rock.T_Rock",
			status: "located"
		});
		expect(yield* recorder.calls()).toEqual([
			"assetNavigation.locate:/Game/Textures/T_Rock.T_Rock"
		]);
	})
);

it.effect("dispatches asset-audits channels to WorkbenchAssetAudits with decoded arguments", () =>
	Effect.gen(function* () {
		const { recorder } = yield* runRegistered((ipc) =>
			Effect.gen(function* () {
				yield* ipc.invoke("asset-audits:textures:configured-scan");
				yield* ipc.invoke("asset-audits:textures:preview", "/Game/Textures/T_Rock");
				yield* ipc.invoke("asset-audits:textures:preview-offline", "/Game/Textures/T_Rock");
				yield* ipc.invoke("asset-audits:textures:preview-offline-batch", {
					objectPaths: ["/Game/Textures/T_Rock", "/Game/Textures/T_Moss"]
				});
			})
		);
		expect(yield* recorder.calls()).toEqual([
			"assetAudits.configuredScan",
			"assetAudits.preview:/Game/Textures/T_Rock",
			"assetAudits.previewOffline:/Game/Textures/T_Rock",
			"assetAudits.previewOfflineBatch:/Game/Textures/T_Rock,/Game/Textures/T_Moss"
		]);
	})
);

it.effect("dispatches game-text channels to WorkbenchGameText", () =>
	Effect.gen(function* () {
		const { recorder } = yield* runRegistered((ipc) => ipc.invoke("game-text:configured-scan"));
		expect(yield* recorder.calls()).toEqual(["gameText.configuredScan"]);
	})
);

it.effect("dispatches Content Observatory query controls to its scoped service", () =>
	Effect.gen(function* () {
		const { recorder } = yield* runRegistered((ipc) =>
			Effect.gen(function* () {
				yield* ipc.invoke("content-observatory:status");
				yield* ipc.invoke("content-observatory:start", {
					mode: "deep",
					limits: {
						maxChangelists: 250,
						maxConcurrency: 4,
						maxDurationMs: 120000,
						maxMaterializedFiles: 4000,
						maxPackages: 4000
					},
					mapPath: "Content/Fixture/History/L_MapHistoryWorld.umap",
					range: {
						since: "2026-07-20T00:00:00.000Z",
						until: "2026-07-27T00:00:00.000Z"
					}
				});
				yield* ipc.invoke("content-observatory:cancel");
			})
		);
		expect(yield* recorder.calls()).toEqual([
			"contentObservatory.status",
			"contentObservatory.start:Content/Fixture/History/L_MapHistoryWorld.umap",
			"contentObservatory.cancel"
		]);
	})
);

it.effect("dispatches input-atlas channels to WorkbenchInputAtlas", () =>
	Effect.gen(function* () {
		const { recorder } = yield* runRegistered((ipc) =>
			Effect.gen(function* () {
				yield* ipc.invoke("input-atlas:configured-scan");
				yield* ipc.invoke("input-atlas:choose-and-scan");
			})
		);
		expect(yield* recorder.calls()).toEqual([
			"inputAtlas.configuredScan",
			"inputAtlas.chooseAndScan"
		]);
	})
);

it.effect("dispatches authoring session channels with decoded session ids and intents", () =>
	Effect.gen(function* () {
		const { recorder } = yield* runRegistered((ipc) =>
			Effect.gen(function* () {
				yield* ipc.invoke("authoring:session:begin", "/Game/Data/DT_Loot");
				yield* ipc.invoke("authoring:session:list");
				yield* ipc.invoke("authoring:session:open", "session-1");
				yield* ipc.invoke("authoring:session:edit", {
					edits: [
						{
							fieldName: "Amount",
							rowId: "Row0",
							value: { kind: "string", value: "1" }
						}
					],
					kind: "set_cells",
					sessionId: "session-1",
					tableObjectPath: "/Game/Data/DT_Loot"
				});
				yield* ipc.invoke("authoring:session:undo", "session-1");
				yield* ipc.invoke("authoring:session:review", "session-1");
				yield* ipc.invoke("authoring:session:discard", "session-1");
			})
		);
		expect(yield* recorder.calls()).toEqual([
			"authoring.beginSession:/Game/Data/DT_Loot",
			"authoring.listSessions",
			"authoring.openSession:session-1",
			"authoring.editSession:session-1",
			"authoring.undoSession:session-1",
			"authoring.reviewSession:session-1",
			"authoring.discardSession:session-1"
		]);
	})
);

it.effect("dispatches camera channels with decoded arguments", () =>
	Effect.gen(function* () {
		const { recorder } = yield* runRegistered((ipc) =>
			Effect.gen(function* () {
				yield* ipc.invoke("camera:metrics");
				yield* ipc.invoke("camera:presentation-budget", 200);
				yield* ipc.invoke("camera:status");
				yield* ipc.invoke("camera:configure", sampleCameraScheduleConfig);
			})
		);
		expect(yield* recorder.calls()).toEqual([
			"cameraPresentation.metrics",
			"cameraPresentation.setPresentationBudget:200",
			"cameraPresentation.status",
			"cameraPresentation.configure:4"
		]);
	})
);

it.effect("dispatches map-review channels to WorkbenchMapReview", () =>
	Effect.gen(function* () {
		const { recorder } = yield* runRegistered((ipc) =>
			Effect.gen(function* () {
				yield* ipc.invoke("map-review:load");
				yield* ipc.invoke("map-review:capture", { viewIds: ["view-1"] });
				yield* ipc.invoke("map-review:preview-candidate", "candidate-1");
			})
		);
		expect(yield* recorder.calls()).toEqual([
			"mapReview.load",
			"mapReview.capture",
			"mapReview.previewCandidate:candidate-1"
		]);
	})
);

it.effect("rejects malformed input instead of reaching the service", () =>
	Effect.gen(function* () {
		const { recorder, result } = yield* runRegistered((ipc) =>
			Effect.gen(function* () {
				return yield* Effect.exit(
					ipc.invoke("asset-audits:textures:preview", "not-a-game-path")
				);
			})
		);
		expect(result._tag).toBe("Failure");
		expect(yield* recorder.calls()).toEqual([]);
	})
);
