import { it } from "@effect/vitest";
import { aggregateHealth, defaultHealthInput } from "@ue-shed/observability";
import { Effect, Exit, Result, Schema } from "effect";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import {
	cameraFrameEvent,
	worldObservationEvent,
	CandidateId,
	decodeCameraFrameEvent,
	GameObjectPath,
	invokeChannelNames,
	invokeContracts,
	PresentationBudgetMbPerSecond,
	SessionId,
	type InvokeChannel
} from "./ipc-contracts.js";

const mainDir = dirname(fileURLToPath(import.meta.url));

const preloadSource = readFileSync(join(mainDir, "preload.ts"), "utf8");

const preloadInvokeChannels = [...preloadSource.matchAll(/ipcRenderer\.invoke\("([^"]+)"/g)].map(
	(match) => match[1]
);

const preloadEventChannels = [...preloadSource.matchAll(/ipcRenderer\.on\("([^"]+)"/g)].map(
	(match) => match[1]
);

const sessionFailure = {
	status: "failed" as const,
	error: {
		code: "test",
		message: "failed",
		recovery: "retry",
		retrySafe: false
	}
};

const cameraStatus = {
	cameras: [],
	config: {
		activeCameraCount: 1,
		backgroundFps: 1,
		captureBudgetPerTick: 1,
		focusedCameraIndex: null,
		focusedFps: 1,
		paused: false,
		pipelineMode: "full_pipeline" as const,
		renderProfile: "observation" as const,
		resolution: "320x180" as const,
		viewMode: "overview" as const
	},
	pipeName: "\\\\.\\pipe\\ue-shed-cameras",
	schemaVersion: 1 as const,
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

const approveIntent = {
	candidateId: "candidate-1",
	candidatePose: {
		aspectRatio: "16:9" as const,
		fieldOfViewDegrees: 90,
		location: { x: 0, y: 0, z: 0 },
		projection: "perspective" as const,
		rotation: { pitch: 0, roll: 0, yaw: 0 }
	},
	sourceActorPath: "/Game/Actor",
	viewId: "view-1"
};

const validArgsByChannel: Record<InvokeChannel, unknown> = {
	"editor-session:status": [],
	"editor-session:execute": ["start_play"],
	"fixture:launch": [],
	"fixture:launch-review": [],
	"showcase:context": [],
	"asset-audits:textures:configured-scan": [],
	"asset-audits:textures:choose-and-scan": [],
	"asset-audits:textures:preview": ["/Game/Textures/Example"],
	"game-text:configured-scan": [],
	"game-text:choose-and-scan": [],
	"authoring:configured-table": [],
	"authoring:configured-catalog": [],
	"authoring:open-catalog-table": ["/Game/Data/Example", "live"],
	"authoring:choose-table": [],
	"authoring:session:begin": ["/Game/Data/Example"],
	"authoring:session:list": [],
	"authoring:session:open": ["session-1"],
	"authoring:session:discard": ["session-1"],
	"authoring:session:edit": [
		{
			edits: [{ fieldName: "Name", rowId: "Row1", value: { kind: "string", value: "x" } }],
			kind: "set_cells",
			sessionId: "session-1",
			tableObjectPath: "/Game/Data/Example"
		}
	],
	"authoring:session:review": ["session-1"],
	"authoring:session:undo": ["session-1"],
	"authoring:session:redo": ["session-1"],
	"authoring:session:apply": ["session-1"],
	"authoring:session:reconcile": ["session-1"],
	"authoring:session:save": ["session-1"],
	"camera:metrics": [],
	"camera:presentation-budget": [80],
	"camera:status": [],
	"camera:configure": [cameraStatus.config],
	"map-review:load": [],
	"map-review:world-snapshot": [],
	"map-review:focus-actor": ["/Game/Fixture.Map:PersistentLevel.Actor", true],
	"map-review:capture": [{ viewIds: ["view-1"] }],
	"map-review:author-from-selection": [],
	"map-review:authoring-resume": [],
	"map-review:authoring-patch": [
		{
			patch: {
				discardedCandidateIds: [],
				manualReason: "",
				selectedCandidateId: "candidate-1"
			},
			sessionId: "session-1"
		}
	],
	"map-review:authoring-reframe": [{ sessionId: "session-1" }],
	"map-review:authoring-discard": [{ sessionId: "session-1" }],
	"map-review:preview-authoring-candidate": [
		{ candidateId: "candidate-1", sessionId: "session-1" }
	],
	"map-review:approve-authoring": [{ sessionId: "session-1" }],
	"map-review:preview-candidate": ["candidate-1"],
	"map-review:approve-candidate": [approveIntent],
	"map-review:set-live-preview-fps": [5],
	"map-review:subscribe-world-observations": [5],
	"map-review:set-world-observation-rate": [5],
	"map-review:unsubscribe-world-observations": []
};

const validResultByChannel: Record<InvokeChannel, unknown> = {
	"editor-session:status": {
		contract: { name: "unreal-editor-play-session", version: { major: 1, minor: 0 } },
		state: { status: "stopped" }
	},
	"editor-session:execute": {
		command: "start_play",
		contract: { name: "unreal-editor-play-session", version: { major: 1, minor: 0 } },
		outcome: "accepted",
		state: { mode: "play", sessionId: "session-1", status: "starting" }
	},
	"fixture:launch": { status: "ready" },
	"fixture:launch-review": {
		status: "failed",
		message: "unavailable",
		recovery: "start the fixture"
	},
	"showcase:context": {
		fixtureConfigured: false,
		health: aggregateHealth(defaultHealthInput),
		reader: "path"
	},
	"asset-audits:textures:configured-scan": { status: "not_configured" },
	"asset-audits:textures:choose-and-scan": { status: "cancelled" },
	"asset-audits:textures:preview": {
		contract: { name: "texture-preview", version: { major: 1, minor: 0 } },
		status: "unavailable",
		objectPath: "",
		reason: "invalid_request",
		message: "Object path must be a /Game/ path.",
		retrySafe: false
	},
	"game-text:configured-scan": { status: "not_configured" },
	"game-text:choose-and-scan": { status: "cancelled" },
	"authoring:configured-table": { status: "not_configured" },
	"authoring:configured-catalog": { status: "not_configured" },
	"authoring:open-catalog-table": { status: "cancelled" },
	"authoring:choose-table": { status: "cancelled" },
	"authoring:session:begin": sessionFailure,
	"authoring:session:list": { diagnostics: [], sessions: [], status: "ready" },
	"authoring:session:open": sessionFailure,
	"authoring:session:discard": { diagnostics: [], sessions: [], status: "ready" },
	"authoring:session:edit": sessionFailure,
	"authoring:session:review": sessionFailure,
	"authoring:session:undo": sessionFailure,
	"authoring:session:redo": sessionFailure,
	"authoring:session:apply": sessionFailure,
	"authoring:session:reconcile": sessionFailure,
	"authoring:session:save": sessionFailure,
	"camera:metrics": undefined,
	"camera:presentation-budget": 80,
	"camera:status": cameraStatus,
	"camera:configure": cameraStatus,
	"map-review:load": { status: "not_configured" },
	"map-review:world-snapshot": {
		message: "offline",
		recovery: "open Unreal",
		status: "unavailable"
	},
	"map-review:focus-actor": {
		actorId: "/Game/Fixture.Map:PersistentLevel.Actor",
		status: "not_supported"
	},
	"map-review:capture": { status: "not_configured" },
	"map-review:author-from-selection": {
		status: "failed",
		error: { message: "missing", recovery: "select an actor" }
	},
	"map-review:authoring-resume": {
		status: "failed",
		error: { message: "missing", recovery: "select an actor" }
	},
	"map-review:authoring-patch": {
		status: "failed",
		error: { message: "missing", recovery: "select an actor" }
	},
	"map-review:authoring-reframe": {
		status: "failed",
		error: { message: "missing", recovery: "select an actor" }
	},
	"map-review:authoring-discard": {
		status: "failed",
		error: { message: "missing", recovery: "select an actor" }
	},
	"map-review:preview-authoring-candidate": {
		status: "failed",
		error: { message: "missing", recovery: "reframe" }
	},
	"map-review:approve-authoring": {
		status: "failed",
		error: { message: "missing", recovery: "reframe" }
	},
	"map-review:preview-candidate": {
		status: "failed",
		error: { message: "missing", recovery: "reframe" }
	},
	"map-review:approve-candidate": { status: "approved", candidateId: "candidate-1" },
	"map-review:set-live-preview-fps": 5,
	"map-review:subscribe-world-observations": undefined,
	"map-review:set-world-observation-rate": 5,
	"map-review:unsubscribe-world-observations": undefined
};

const malformedArgsByChannel: Partial<Record<InvokeChannel, unknown>> = {
	"asset-audits:textures:preview": ["/Engine/Textures/Bad"],
	"authoring:open-catalog-table": ["", "automatic"],
	"authoring:session:begin": [42],
	"authoring:session:open": [""],
	"authoring:session:discard": [null],
	"authoring:session:edit": [{ kind: "set_cells" }],
	"authoring:session:review": [""],
	"authoring:session:undo": [""],
	"authoring:session:redo": [null],
	"authoring:session:apply": [{}],
	"authoring:session:reconcile": [""],
	"authoring:session:save": [undefined],
	"camera:presentation-budget": [Number.NaN],
	"camera:configure": [{ paused: true }],
	"map-review:preview-candidate": [""],
	"map-review:authoring-patch": [{ patch: {}, sessionId: "" }],
	"map-review:authoring-reframe": [{ sessionId: "" }],
	"map-review:authoring-discard": [{ sessionId: "" }],
	"map-review:preview-authoring-candidate": [{ candidateId: "", sessionId: "" }],
	"map-review:approve-authoring": [{ sessionId: "" }],
	"map-review:capture": [{ viewIds: [] }],
	"map-review:approve-candidate": [{ candidateId: "only" }],
	"map-review:set-live-preview-fps": ["fast"],
	"map-review:subscribe-world-observations": [0],
	"map-review:set-world-observation-rate": [0]
};

it("registers exactly 46 invoke channels plus camera and world-observation events", () => {
	expect(invokeChannelNames).toHaveLength(46);
	expect(new Set(invokeChannelNames).size).toBe(46);
	expect(cameraFrameEvent.channel).toBe("camera:frame");
	expect(worldObservationEvent.channel).toBe("map-review:world-observation");
});

it("keeps contract channels in exact preload parity", () => {
	expect([...preloadInvokeChannels].sort()).toEqual([...invokeChannelNames].sort());
	expect(preloadEventChannels.toSorted()).toEqual(
		["camera:frame", "map-review:world-observation"].toSorted()
	);
});

it("decodes valid arguments for every invoke channel", () => {
	for (const channel of invokeChannelNames) {
		const decoded = Schema.decodeUnknownResult(invokeContracts[channel].args)(
			validArgsByChannel[channel]
		);
		expect(Result.isSuccess(decoded)).toBe(true);
		if (Result.isSuccess(decoded)) {
			expect(Array.isArray(decoded.success)).toBe(true);
		}
	}
});

it("rejects no-input channels that receive unexpected values", () => {
	for (const channel of invokeChannelNames) {
		if ((validArgsByChannel[channel] as ReadonlyArray<unknown>).length !== 0) continue;
		const decoded = Schema.decodeUnknownResult(invokeContracts[channel].args)(["unexpected"]);
		expect(Result.isFailure(decoded)).toBe(true);
	}
});

it("rejects malformed input for every input-bearing channel", () => {
	for (const [channel, args] of Object.entries(malformedArgsByChannel) as Array<
		[InvokeChannel, unknown]
	>) {
		const decoded = Schema.decodeUnknownResult(invokeContracts[channel].args)(args);
		expect(Result.isFailure(decoded)).toBe(true);
	}
});

it("validates representative outputs for every invoke channel", () => {
	for (const channel of invokeChannelNames) {
		const decoded = Schema.decodeUnknownResult(invokeContracts[channel].result)(
			validResultByChannel[channel]
		);
		expect(Result.isSuccess(decoded)).toBe(true);
	}
});

it("rejects malformed outputs for every invoke channel", () => {
	for (const channel of invokeChannelNames) {
		const decoded = Schema.decodeUnknownResult(invokeContracts[channel].result)({
			status: "not-a-real-result"
		});
		expect(Result.isFailure(decoded)).toBe(true);
	}
});

it.effect("clamps finite presentation budgets into 25–500 MB/s", () =>
	Effect.gen(function* () {
		expect(yield* Schema.decodeUnknownEffect(PresentationBudgetMbPerSecond)(10)).toBe(25);
		expect(yield* Schema.decodeUnknownEffect(PresentationBudgetMbPerSecond)(80)).toBe(80);
		expect(yield* Schema.decodeUnknownEffect(PresentationBudgetMbPerSecond)(900)).toBe(500);
		const invalid = yield* Schema.decodeUnknownEffect(PresentationBudgetMbPerSecond)(
			Number.POSITIVE_INFINITY
		).pipe(Effect.exit);
		expect(Exit.isFailure(invalid)).toBe(true);
	})
);

it.effect("constrains game object paths, session ids, and candidate ids", () =>
	Effect.gen(function* () {
		expect(yield* Schema.decodeUnknownEffect(GameObjectPath)("/Game/Data/Table")).toBe(
			"/Game/Data/Table"
		);
		const badPath = yield* Schema.decodeUnknownEffect(GameObjectPath)("/Engine/Foo").pipe(
			Effect.exit
		);
		expect(Exit.isFailure(badPath)).toBe(true);

		expect(yield* Schema.decodeUnknownEffect(CandidateId)("candidate-1")).toBe("candidate-1");
		const emptyCandidate = yield* Schema.decodeUnknownEffect(CandidateId)("").pipe(Effect.exit);
		expect(Exit.isFailure(emptyCandidate)).toBe(true);

		expect(yield* Schema.decodeUnknownEffect(SessionId)("session-1")).toBe("session-1");
		const emptySession = yield* Schema.decodeUnknownEffect(SessionId)("").pipe(Effect.exit);
		expect(Exit.isFailure(emptySession)).toBe(true);
	})
);

it.effect("decodes renderer camera frames with decimal sequence strings", () =>
	decodeCameraFrameEvent({
		cameraId: "cam",
		cameraIndex: 0,
		captureMonotonicMs: 1,
		height: 90,
		pixels: new Uint8Array([1, 2, 3]),
		producerId: "producer",
		readbackDrops: 0,
		readbackLatencyMs: 0,
		receivedMonotonicMs: 2,
		sequence: "42",
		sessionId: "session",
		transportReplacements: 0,
		width: 160,
		worldSeconds: 0.1
	}).pipe(Effect.asVoid)
);
