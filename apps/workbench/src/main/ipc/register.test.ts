import { it } from "@effect/vitest";
import type { TextureAuditRunResult, TexturePreviewResult } from "@ue-shed/asset-audits";
import type { MapReviewApprovalResult } from "@ue-shed/cameras/review-contracts";
import type { TextCorpusRunResult } from "@ue-shed/game-text";
import type { CameraScheduleConfig, CameraStatus } from "@ue-shed/protocol";
import { Effect, Layer, Ref } from "effect";
import { expect } from "vitest";
import { ElectronIpcTest, makeElectronIpcTestLayer } from "../adapters/electron-ipc.js";
import { invokeChannelNames } from "../ipc-contracts.js";
import { makeWorkbenchAssetAuditsTestLayer } from "../services/asset-audits.js";
import { makeWorkbenchAuthoringTestLayer } from "../services/authoring.js";
import { makeCameraPresentationTestLayer } from "../services/camera-presentation.js";
import { makeFixtureLauncherTestLayer } from "../services/fixture-launcher.js";
import { makeWorkbenchGameTextTestLayer } from "../services/game-text.js";
import { makeWorkbenchMapReviewTestLayer } from "../services/map-review.js";
import { makeShowcaseTestLayer } from "../services/showcase.js";
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

	const sessionFailure = {
		status: "failed" as const,
		error: { code: "test", message: "m", recovery: "r", retrySafe: false }
	};

	const authoring = makeWorkbenchAuthoringTestLayer({
		applySession: (sessionId) =>
			recorder.record(`authoring.applySession:${sessionId}`).pipe(Effect.as(sessionFailure)),
		beginSession: (objectPath) =>
			recorder.record(`authoring.beginSession:${objectPath}`).pipe(Effect.as(sessionFailure)),
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
		openCatalogTable: (objectPath) =>
			recorder
				.record(`authoring.openCatalogTable:${objectPath}`)
				.pipe(Effect.as({ status: "not_configured" as const })),
		reconcileSession: (sessionId) =>
			recorder
				.record(`authoring.reconcileSession:${sessionId}`)
				.pipe(Effect.as(sessionFailure)),
		redoSession: (sessionId) =>
			recorder.record(`authoring.redoSession:${sessionId}`).pipe(Effect.as(sessionFailure)),
		saveSession: (sessionId) =>
			recorder.record(`authoring.saveSession:${sessionId}`).pipe(Effect.as(sessionFailure)),
		undoSession: (sessionId) =>
			recorder.record(`authoring.undoSession:${sessionId}`).pipe(Effect.as(sessionFailure))
	});

	const mapReview = makeWorkbenchMapReviewTestLayer({
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
		capture: () =>
			recorder
				.record("mapReview.capture")
				.pipe(Effect.as({ status: "not_configured" as const })),
		load: () =>
			recorder
				.record("mapReview.load")
				.pipe(Effect.as({ status: "not_configured" as const })),
		previewCandidate: (candidateId) =>
			recorder
				.record(`mapReview.previewCandidate:${candidateId}`)
				.pipe(
					Effect.as({ status: "failed" as const, error: { message: "m", recovery: "r" } })
				)
	});

	const fixtureLauncher = makeFixtureLauncherTestLayer({
		launch: (mode) =>
			recorder
				.record(`fixtureLauncher.launch:${mode}`)
				.pipe(Effect.as({ status: "ready" as const }))
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

	return Layer.mergeAll(
		showcase,
		assetAudits,
		gameText,
		authoring,
		mapReview,
		fixtureLauncher,
		cameraPresentation
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

it.effect("registers exactly the 28 contract channels", () =>
	Effect.gen(function* () {
		const { result } = yield* runRegistered((ipc) => ipc.handlers());
		expect(result.map((entry) => entry.channel).toSorted()).toEqual(
			[...invokeChannelNames].toSorted()
		);
		expect(result).toHaveLength(28);
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

it.effect("dispatches showcase:context to Showcase.context", () =>
	Effect.gen(function* () {
		const { recorder } = yield* runRegistered((ipc) => ipc.invoke("showcase:context"));
		expect(yield* recorder.calls()).toEqual(["showcase.context"]);
	})
);

it.effect("dispatches asset-audits channels to WorkbenchAssetAudits with decoded arguments", () =>
	Effect.gen(function* () {
		const { recorder } = yield* runRegistered((ipc) =>
			Effect.gen(function* () {
				yield* ipc.invoke("asset-audits:textures:configured-scan");
				yield* ipc.invoke("asset-audits:textures:preview", "/Game/Textures/T_Rock");
			})
		);
		expect(yield* recorder.calls()).toEqual([
			"assetAudits.configuredScan",
			"assetAudits.preview:/Game/Textures/T_Rock"
		]);
	})
);

it.effect("dispatches game-text channels to WorkbenchGameText", () =>
	Effect.gen(function* () {
		const { recorder } = yield* runRegistered((ipc) => ipc.invoke("game-text:configured-scan"));
		expect(yield* recorder.calls()).toEqual(["gameText.configuredScan"]);
	})
);

it.effect("dispatches authoring session channels with decoded session ids and intents", () =>
	Effect.gen(function* () {
		const { recorder } = yield* runRegistered((ipc) =>
			Effect.gen(function* () {
				yield* ipc.invoke("authoring:session:begin", "/Game/Data/DT_Loot");
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
			})
		);
		expect(yield* recorder.calls()).toEqual([
			"authoring.beginSession:/Game/Data/DT_Loot",
			"authoring.editSession:session-1",
			"authoring.undoSession:session-1"
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
				yield* ipc.invoke("map-review:capture");
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
