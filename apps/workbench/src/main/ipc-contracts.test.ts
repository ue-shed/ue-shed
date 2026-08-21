import { it } from "@effect/vitest";
import { aggregateHealth, defaultHealthInput } from "@ue-shed/observability";
import {
	movementGymRuns,
	movementGymScenario,
	ScenarioRunHandle,
	scenarioWireContract
} from "@ue-shed/scenarios";
import { Effect, Exit, Result, Schema } from "effect";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import {
	CameraStatusResult,
	cameraFrameEvent,
	decodeMapCaptureProgressEvent,
	mapCaptureProgressEvent,
	worldObservationEvent,
	CandidateId,
	decodeCameraFrameEvent,
	GameObjectPath,
	invokeChannelNames,
	invokeContracts,
	PresentationBudgetMbPerSecond,
	RemoteControlPort,
	SessionId,
	type InvokeArguments,
	type InvokeChannel,
	type InvokeResult
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

const scenarioHandle = ScenarioRunHandle.make({
	endpoint: "http://127.0.0.1:30001",
	evidenceLimit: 8,
	objectPath: "/Script/Fixture.Scenarios",
	pieSessionId: "pie-session-1",
	runId: "run-live-1",
	scenarioId: movementGymScenario.id
});

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

const qualityRuleDocument = {
	roles: [
		{
			id: "menu.prompt",
			scopes: [
				{
					matchers: [{ kind: "location_kind", value: "string_table_entry" }]
				}
			]
		}
	],
	rules: [
		{
			id: "menu.prompt.characters",
			kind: "character_budget",
			maximumCharacters: 32,
			recovery: "Shorten the prompt.",
			role: "menu.prompt"
		}
	],
	schemaVersion: 1
} satisfies InvokeArguments<"game-text:quality:preview-rules">[0];

it.effect("represents a stopped game world as unavailable camera status", () =>
	Schema.decodeUnknownEffect(CameraStatusResult)({
		message: "Camera streaming is unavailable in the current editor state.",
		recovery: "Start a Play or Simulate session before opening Camera Lab streaming.",
		status: "unavailable"
	}).pipe(Effect.asVoid)
);

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

const mapCapturePlan = {
	capture: {
		dataLayers: { mode: "unchanged" },
		orientation: { pitch: -90, roll: 0, yaw: 0 },
		render: {
			effects: { fog: false, volumetricFog: false },
			lodDistanceScaleByZoom: [2],
			lodPolicy: "per_level_distance_scale",
			profile: "full_fidelity"
		},
		z: 5000
	},
	contract: { name: "ue-shed-map-capture-plan", version: { major: 1, minor: 0 } },
	gutterPixels: 2,
	id: "fixture-overview",
	levels: { coarsestUnitsPerPixel: 4, count: 1 },
	output: { imageFormat: "png", publication: "local_immutable" },
	project: { id: "fixture", mapPath: "/Game/Fixture/Cameras/L_CameraLoad" },
	requestedBounds: { maxX: 1024, maxY: 1024, minX: 0, minY: 0 },
	tilePixelSize: 256
} satisfies InvokeArguments<"map-capture:open-map">[0];

interface IpcFixtureObject {
	readonly [key: string]: IpcFixtureValue;
}

type IpcFixtureValue =
	| undefined
	| null
	| boolean
	| number
	| string
	| Uint8Array
	| readonly IpcFixtureValue[]
	| IpcFixtureObject;

type ValidArgsByChannel = {
	readonly [Channel in InvokeChannel]: InvokeArguments<Channel>;
};

type ValidResultByChannel = {
	readonly [Channel in InvokeChannel]: InvokeResult<Channel>;
};

const validArgsByChannel = {
	"editor-session:settings": [],
	"editor-session:set-port": [31001],
	"editor-session:status": [],
	"editor-session:execute": ["start_play"],
	"scenario:start": [movementGymScenario, scenarioHandle.endpoint],
	"scenario:status": [scenarioHandle],
	"scenario:cancel": [scenarioHandle],
	"fixture:launch": [],
	"fixture:launch-review": [],
	"showcase:context": [],
	"config-explorer:query": [
		{
			family: "Game",
			key: "Entries",
			leftPlatform: "PlatformA",
			mode: "compare",
			rightPlatform: "PlatformB",
			section: "Fixture.Settings",
			source: "sample_fixture"
		}
	],
	"project-custodian:configured-scan": [],
	"project-custodian:choose-and-scan": [],
	"project-custodian:prepare": [
		{
			root: "C:/Projects",
			ignorePressure: false,
			mode: "trash",
			targetIds: ["target-1"]
		}
	],
	"project-custodian:execute": [
		{ proposalPath: "C:/Records/proposal.json", approvalPhrase: "RECLAIM proposal-1" }
	],
	"project-custodian:cancel": ["proposal-1"],
	"project:current": [],
	"project:choose": [],
	"project:progress": [],
	"project:launch": ["ue_shed"],
	"asset-audits:textures:configured-scan": [],
	"asset-audits:textures:choose-and-scan": [],
	"asset-audits:textures:configured-refresh": [],
	"asset-audits:textures:choose-and-refresh": [],
	"asset-audits:textures:progress": [],
	"asset-audits:textures:search": [{ findingsOnly: false, pageSize: 100, query: "" }],
	"asset-audits:textures:record": ["/Game/Textures/Example"],
	"asset-audits:textures:preview": ["/Game/Textures/Example"],
	"asset-audits:textures:preview-offline": ["/Game/Textures/Example"],
	"asset-audits:textures:preview-offline-batch": [{ objectPaths: ["/Game/Textures/Example"] }],
	"game-text:configured-scan": [],
	"game-text:choose-and-scan": [],
	"game-text:configured-refresh": [],
	"game-text:choose-and-refresh": [],
	"game-text:progress": [],
	"game-text:search": [{ capability: "all", pageSize: 50, query: "" }],
	"game-text:focus": [{ id: "unreal:UI:Example", pageSize: 50 }],
	"game-text:quality:choose-rules": [],
	"game-text:quality:preview-rules": [qualityRuleDocument],
	"game-text:quality:save-rules": [qualityRuleDocument],
	"game-text:quality:search": [{ filter: "all", pageSize: 50 }],
	"game-text:quality:focus": [{ id: "quality-finding:1", pageSize: 50 }],
	"asset-navigation:locate": ["/Game/Text/ST_Game.ST_Game"],
	"input-atlas:configured-scan": [],
	"input-atlas:choose-and-scan": [],
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
	"content-observatory:status": [],
	"content-observatory:targets": ["Content/Fixture/History/L_MapHistoryWorld.umap"],
	"content-observatory:start": [
		{
			mode: "deep",
			limits: {
				maxChangelists: 250,
				maxConcurrency: 4,
				maxDurationMs: 120000,
				maxMaterializedFiles: 4000,
				maxPackages: 4000
			},
			mapPath: "Content/Fixture/History/L_MapHistoryWorld.umap",
			range: { since: "2026-07-20T00:00:00.000Z", until: "2026-07-27T00:00:00.000Z" }
		}
	],
	"content-observatory:cancel": [],
	"map-review:load": [],
	"map-capture:actors": ["/Game/Maps/L_City"],
	"map-capture:choose-plan": [],
	"map-capture:new-plan": [],
	"map-capture:open-map": [mapCapturePlan],
	"map-capture:preview": [mapCapturePlan],
	"map-capture:save-plan": [{ plan: mapCapturePlan, saveAs: false }],
	"map-capture:capture": [
		{
			captureBackend: "scene_capture_tiles",
			openMap: true,
			operationId: "capture-ui-operation-1",
			plan: mapCapturePlan
		}
	],
	"map-capture:tile": [
		{
			manifestPath: "D:/Projects/Demo/.ue-shed/map-capture/runs/plan/run/manifest.json",
			relativePath: "Z00/R000_C000.png"
		}
	],
	"niagara-preview:run": [
		{
			settings: {
				captureMode: "component_only",
				durationSeconds: 1,
				frameCount: 12,
				height: 512,
				simulationFramesPerSecond: 60,
				startSeconds: 0,
				width: 512
			},
			systemObjectPath:
				"/Niagara/DefaultAssets/Templates/Systems/SimpleExplosion.SimpleExplosion"
		}
	],
	"niagara-preview:frame": [
		{
			manifestPath: "D:/Projects/Demo/.ue-shed/niagara-preview/runs/run-id/manifest.json",
			relativePath: "frames/frame_0000.png"
		}
	],
	"map-review:review-sets": [],
	"map-review:create-review-set": [{ displayName: "Lighting review" }],
	"map-review:select-review-set": [{ reviewSetId: "lighting-review" }],
	"map-review:world-snapshot": [],
	"map-review:saved-world": ["Content/Fixture/Offline/L_OfflineWorld.umap"],
	"map-review:saved-world-maps": [],
	"map-review:choose-project-and-maps": [],
	"map-review:focus-actor": ["/Game/Fixture.Map:PersistentLevel.Actor", true],
	"map-review:capture": [{ viewIds: ["view-1"] }],
	"map-review:apply-visibility-policy": [{ policyId: "natural", viewIds: ["view-1"] }],
	"map-review:replace-visibility-policy": [
		{
			policy: {
				assessment: { method: "automatic" },
				id: "natural-v2",
				name: "Natural v2",
				onLowVisibility: { action: "record" },
				output: { mode: "natural_only" }
			},
			viewId: "view-1"
		}
	],
	"map-review:author-from-selection": [{ destination: { kind: "append_view" } }],
	"map-review:authoring-resume": [],
	"map-review:authoring-patch": [
		{
			patch: {
				candidateOverrides: [
					{
						candidateId: "preset/context/1",
						overrides: { elevation: 0.4 }
					}
				],
				discardedCandidateIds: [],
				framingParameters: {
					fieldOfViewDegrees: 60,
					groups: [
						{
							displayName: "Context",
							distanceScale: 1.8,
							elevation: 0.5,
							enabled: true,
							id: "context",
							pattern: {
								count: 3,
								kind: "arc",
								spreadDegrees: 45,
								yawOffsetDegrees: 30
							}
						}
					],
					margin: 0.12
				},
				manualReason: "",
				selectedCandidateId: "preset/context/1"
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
} satisfies ValidArgsByChannel;

const validResultByChannel = {
	"editor-session:settings": { port: 30001 },
	"editor-session:set-port": { port: 31001 },
	"editor-session:status": {
		session: {
			contract: { name: "unreal-editor-play-session", version: { major: 1, minor: 0 } },
			state: { status: "stopped" }
		},
		status: "ready"
	},
	"editor-session:execute": {
		command: "start_play",
		contract: { name: "unreal-editor-play-session", version: { major: 1, minor: 0 } },
		outcome: "accepted",
		state: { mode: "play", sessionId: "session-1", status: "starting" }
	},
	"scenario:start": scenarioHandle,
	"scenario:status": {
		_tag: "Terminal",
		contract: scenarioWireContract,
		result: movementGymRuns[1]!
	},
	"scenario:cancel": movementGymRuns[1]!,
	"fixture:launch": { status: "ready" },
	"fixture:launch-review": {
		status: "failed",
		message: "unavailable",
		recovery: "start the fixture"
	},
	"showcase:context": {
		fixtureConfigured: false,
		health: aggregateHealth(defaultHealthInput),
		project: { status: "not_configured" },
		reader: "path"
	},
	"config-explorer:query": {
		error: {
			code: "sample_unavailable",
			message: "Fixture unavailable.",
			recovery: "Launch through pnpm showcase.",
			retrySafe: false
		},
		status: "failed"
	},
	"project-custodian:configured-scan": { status: "not_configured" },
	"project-custodian:choose-and-scan": { status: "cancelled" },
	"project-custodian:prepare": {
		status: "failed",
		error: {
			code: "prepare_failed",
			message: "Proposal unavailable.",
			recovery: "Rescan and retry.",
			retrySafe: true
		}
	},
	"project-custodian:execute": {
		status: "failed",
		error: {
			code: "execution_failed",
			message: "Execution unavailable.",
			recovery: "Inspect the event log.",
			retrySafe: false
		}
	},
	"project-custodian:cancel": {
		status: "failed",
		error: {
			code: "execution_failed",
			message: "Cancellation unavailable.",
			recovery: "Inspect the running cleanup.",
			retrySafe: true
		}
	},
	"project:current": { status: "not_configured" },
	"project:choose": { status: "cancelled" },
	"project:progress": {
		cacheHits: 0,
		completed: 0,
		phase: "idle",
		stage: "project_index",
		total: 0
	},
	"project:launch": { mode: "ue_shed", status: "launched" },
	"asset-audits:textures:configured-scan": { status: "not_configured" },
	"asset-audits:textures:choose-and-scan": { status: "cancelled" },
	"asset-audits:textures:configured-refresh": { status: "not_configured" },
	"asset-audits:textures:choose-and-refresh": { status: "cancelled" },
	"asset-audits:textures:progress": {
		completed: 0,
		phase: "idle",
		stage: "texture_audit",
		total: 0
	},
	"asset-audits:textures:search": { status: "not_ready" },
	"asset-audits:textures:record": { status: "not_ready" },
	"asset-audits:textures:preview": {
		contract: { name: "texture-preview", version: { major: 1, minor: 0 } },
		status: "unavailable",
		objectPath: "",
		reason: "invalid_request",
		message: "Object path must be a /Game/ path.",
		retrySafe: false
	},
	"asset-audits:textures:preview-offline": {
		contract: { name: "texture-preview", version: { major: 1, minor: 0 } },
		status: "unavailable",
		objectPath: "/Game/Textures/Example",
		reason: "offline_unavailable",
		message: "Offline preview is unavailable.",
		retrySafe: false
	},
	"asset-audits:textures:preview-offline-batch": {
		cached: 0,
		generated: 1,
		previews: [
			{
				contract: { name: "texture-preview", version: { major: 1, minor: 0 } },
				status: "unavailable",
				objectPath: "/Game/Textures/Example",
				reason: "offline_unavailable",
				message: "Offline preview is unavailable.",
				retrySafe: false
			}
		]
	},
	"game-text:configured-scan": { status: "not_configured" },
	"game-text:choose-and-scan": { status: "cancelled" },
	"game-text:configured-refresh": { status: "not_configured" },
	"game-text:choose-and-refresh": { status: "cancelled" },
	"game-text:progress": {
		completed: 0,
		phase: "idle",
		stage: "game_text",
		total: 0
	},
	"game-text:search": { status: "not_ready" },
	"game-text:focus": { status: "not_ready" },
	"game-text:quality:choose-rules": { status: "not_ready" },
	"game-text:quality:preview-rules": { status: "not_ready" },
	"game-text:quality:save-rules": { status: "not_ready" },
	"game-text:quality:search": { status: "not_ready" },
	"game-text:quality:focus": { status: "not_ready" },
	"asset-navigation:locate": {
		contract: { name: "unreal-editor-asset-navigation", version: { major: 1, minor: 0 } },
		objectPath: "/Game/Text/ST_Game.ST_Game",
		status: "located"
	},
	"input-atlas:configured-scan": { status: "not_configured" },
	"input-atlas:choose-and-scan": { status: "cancelled" },
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
	"camera:status": { camera: cameraStatus, status: "ready" },
	"camera:configure": cameraStatus,
	"content-observatory:status": { status: "not_configured" },
	"content-observatory:targets": {
		authority: { kind: "project_files", mapPackage: "/Game/Maps/L_MapHistoryWorld" },
		completeness: "complete",
		contract: { name: "unreal-saved-world", version: { major: 2, minor: 0 } },
		diagnostics: [],
		mapPath: "Content/Fixture/History/L_MapHistoryWorld.umap",
		actors: [],
		sourceKind: "level",
		summary: {
			failedPackages: 0,
			partialPackages: 0,
			resolvedActors: 0,
			scannedPackages: 1
		}
	},
	"content-observatory:start": { status: "not_configured" },
	"content-observatory:cancel": { status: "not_configured" },
	"map-review:load": { status: "not_configured" },
	"map-capture:actors": {
		message: "Saved actors unavailable.",
		recovery: "Choose a saved map.",
		status: "failed"
	},
	"map-capture:choose-plan": { status: "cancelled" },
	"map-capture:new-plan": { status: "cancelled" },
	"map-capture:open-map": {
		message: "Editor unavailable.",
		recovery: "Connect Unreal.",
		status: "failed"
	},
	"map-capture:preview": {
		message: "Editor unavailable.",
		recovery: "Connect Unreal.",
		status: "failed"
	},
	"map-capture:save-plan": { status: "cancelled" },
	"map-capture:capture": {
		message: "Capture unavailable.",
		recovery: "Connect Unreal.",
		status: "failed"
	},
	"map-capture:tile": { bytes: new Uint8Array([1, 2, 3]), status: "ready" },
	"niagara-preview:run": {
		error: {
			code: "plugin_unavailable",
			message: "UEShedNiagara is not installed.",
			recovery: "Install the separately enabled Editor plugin.",
			retrySafe: false,
			stage: "validation"
		},
		status: "failed"
	},
	"niagara-preview:frame": { bytes: new Uint8Array([1, 2, 3]), status: "ready" },
	"map-review:review-sets": {
		activeReviewSetId: "fixture-review-set",
		sets: [
			{
				displayName: "Fixture Review Set",
				id: "fixture-review-set",
				mapPath: "/Game/Maps/Fixture",
				viewCount: 1
			}
		],
		status: "ready"
	},
	"map-review:create-review-set": { status: "not_configured" },
	"map-review:select-review-set": { status: "not_configured" },
	"map-review:world-snapshot": {
		message: "offline",
		recovery: "open Unreal",
		status: "unavailable"
	},
	"map-review:saved-world": {
		authority: { kind: "project_files", mapPackage: "/Game/Fixture/Offline/L_OfflineWorld" },
		completeness: "complete",
		contract: { name: "unreal-saved-world", version: { major: 2, minor: 0 } },
		diagnostics: [],
		externalActorRoot: "Content/__ExternalActors__/Fixture/Offline/L_OfflineWorld",
		mapPath: "Content/Fixture/Offline/L_OfflineWorld.umap",
		sourceKind: "world_partition",
		actors: [],
		summary: { failedPackages: 0, partialPackages: 0, resolvedActors: 0, scannedPackages: 0 }
	},
	"map-review:saved-world-maps": [
		{ label: "Offline World", mapPath: "Content/Fixture/Offline/L_OfflineWorld.umap" }
	],
	"map-review:choose-project-and-maps": {
		status: "configured",
		projectRoot: "D:/Projects/DemoGame",
		projectName: "DemoGame",
		maps: [{ label: "Offline World", mapPath: "Content/Fixture/Offline/L_OfflineWorld.umap" }]
	},
	"map-review:focus-actor": {
		actorId: "/Game/Fixture.Map:PersistentLevel.Actor",
		status: "not_supported"
	},
	"map-review:capture": { status: "not_configured" },
	"map-review:apply-visibility-policy": { status: "not_configured" },
	"map-review:replace-visibility-policy": { status: "not_configured" },
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
} satisfies ValidResultByChannel;

const malformedArgsByChannel = {
	"editor-session:set-port": [65_536],
	"asset-audits:textures:preview": ["/Engine/Textures/Bad"],
	"asset-audits:textures:preview-offline": ["/Engine/Textures/Bad"],
	"asset-audits:textures:preview-offline-batch": [
		{ objectPaths: Array.from({ length: 101 }, () => "/Game/Textures/TooMany") }
	],
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
	"content-observatory:start": [{ mapPath: "" }],
	"content-observatory:targets": [""],
	"map-review:preview-candidate": [""],
	"map-review:authoring-patch": [{ patch: {}, sessionId: "" }],
	"map-review:authoring-reframe": [{ sessionId: "" }],
	"map-review:authoring-discard": [{ sessionId: "" }],
	"map-review:preview-authoring-candidate": [{ candidateId: "", sessionId: "" }],
	"map-review:approve-authoring": [{ sessionId: "" }],
	"map-review:capture": [{ viewIds: [] }],
	"map-review:create-review-set": [{ displayName: "" }],
	"map-review:select-review-set": [{ reviewSetId: "" }],
	"map-review:approve-candidate": [{ candidateId: "only" }],
	"map-review:set-live-preview-fps": ["fast"],
	"map-review:subscribe-world-observations": [0],
	"map-review:set-world-observation-rate": [0],
	"map-capture:tile": [{ manifestPath: "", relativePath: "../outside.png" }]
} satisfies Partial<Record<InvokeChannel, IpcFixtureValue>>;

it("registers exactly 103 invoke channels plus renderer events", () => {
	expect(invokeChannelNames).toHaveLength(103);
	expect(new Set(invokeChannelNames).size).toBe(103);
	expect(cameraFrameEvent.channel).toBe("camera:frame");
	expect(mapCaptureProgressEvent.channel).toBe("map-capture:progress");
	expect(worldObservationEvent.channel).toBe("map-review:world-observation");
});

it.effect("decodes map-capture progress events", () =>
	decodeMapCaptureProgressEvent({
		failedTiles: 1,
		operationId: "capture-ui-operation-1",
		phase: "capturing",
		processedTiles: 64,
		totalTiles: 84
	})
);

it("keeps contract channels in exact preload parity", () => {
	expect([...preloadInvokeChannels].sort()).toEqual([...invokeChannelNames].sort());
	expect(preloadEventChannels.toSorted()).toEqual(
		["camera:frame", "map-capture:progress", "map-review:world-observation"].toSorted()
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
		// SAFETY: validArgsByChannel is exhaustive and each value is an encoded argument tuple.
		if ((validArgsByChannel[channel] as ReadonlyArray<unknown>).length !== 0) continue;
		const decoded = Schema.decodeUnknownResult(invokeContracts[channel].args)(["unexpected"]);
		expect(Result.isFailure(decoded)).toBe(true);
	}
});

it("rejects malformed input for every input-bearing channel", () => {
	// SAFETY: malformedArgsByChannel is declared as an exhaustive InvokeChannel-keyed record.
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

it.effect("accepts only valid Remote Control ports", () =>
	Effect.gen(function* () {
		expect(yield* Schema.decodeUnknownEffect(RemoteControlPort)(30001)).toBe(30001);
		for (const value of [0, 65_536, 30001.5, "30001"]) {
			const result = yield* Schema.decodeUnknownEffect(RemoteControlPort)(value).pipe(
				Effect.exit
			);
			expect(Exit.isFailure(result)).toBe(true);
		}
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
