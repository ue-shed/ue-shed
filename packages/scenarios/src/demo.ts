import type { ScenarioDocument, ScenarioRun } from "./schema.js";
import {
	makeScenarioElementId,
	makeScenarioId,
	makeScenarioRunId,
	makeTimelineDurationMs,
	makeTimelineTimeMs
} from "./schema.js";

const elementId = makeScenarioElementId;
const at = makeTimelineTimeMs;
const duration = makeTimelineDurationMs;

export const movementGymScenario: ScenarioDocument = {
	schemaVersion: 1,
	id: makeScenarioId("scenario_movement-gym_014"),
	title: "The Broken Bridge",
	description:
		"Cross the traversal gap, wait for the landing volume, and interact with the cache.",
	mapPath: "/Game/Fixture/Scenarios/L_MovementGym",
	durationMs: duration(9200),
	timePolicy: "game_time",
	liveInputPolicy: "isolated",
	seed: 1847,
	tags: ["traversal", "enhanced-input", "evidence-first"],
	setupOperations: [
		"LoadMap(/Game/Fixture/Scenarios/L_MovementGym)",
		"SpawnPawn(PlayerStart.Scenario)",
		"SetSeed(1847)"
	],
	checkpoints: [
		{
			id: elementId("checkpoint_start"),
			label: "Fresh map",
			atMs: at(0),
			strategy: "restart_map",
			restoreOperation: "RestartMap"
		},
		{
			id: elementId("checkpoint_landed"),
			label: "Across the gap",
			atMs: at(6000),
			strategy: "save_game",
			restoreOperation: "RestoreScenarioCheckpoint(Landed)"
		}
	],
	nonSeekableIntervals: [
		{
			startMs: at(2850),
			endMs: at(4300),
			reason: "The jump must be replayed from a saved restart point."
		}
	],
	tracks: [
		{
			kind: "semantic_actions",
			id: elementId("track_intent"),
			label: "Player actions",
			observedAt: "evaluated_action",
			injectAt: "evaluated_action",
			clips: [
				{
					kind: "semantic_action",
					id: elementId("action_move_approach"),
					label: "Move",
					actionPath: "/Game/Fixture/Input/IA_Move",
					startMs: at(820),
					durationMs: duration(2700),
					phase: "ongoing",
					keyframes: [
						{ offsetMs: at(0), value: { x: 0, y: 0.25 } },
						{ offsetMs: at(380), value: { x: 0.08, y: 1 } },
						{ offsetMs: at(2280), value: { x: -0.04, y: 1 } },
						{ offsetMs: at(2700), value: { x: 0, y: 0 } }
					],
					note: "Input values copied from Take 03."
				},
				{
					kind: "semantic_action",
					id: elementId("action_jump"),
					label: "Jump",
					actionPath: "/Game/Fixture/Input/IA_Jump",
					startMs: at(2860),
					durationMs: duration(180),
					phase: "triggered",
					keyframes: [
						{ offsetMs: at(0), value: true },
						{ offsetMs: at(180), value: false }
					],
					note: "Moved 120 ms earlier than the recorded take."
				},
				{
					kind: "semantic_action",
					id: elementId("action_interact"),
					label: "Interact",
					actionPath: "/Game/Fixture/Input/IA_Interact",
					startMs: at(5280),
					durationMs: duration(240),
					phase: "triggered",
					keyframes: [
						{ offsetMs: at(0), value: true },
						{ offsetMs: at(240), value: false }
					],
					note: "Runs only after LandingReady resolves."
				},
				{
					kind: "semantic_action",
					id: elementId("action_move_exit"),
					label: "Move",
					actionPath: "/Game/Fixture/Input/IA_Move",
					startMs: at(6420),
					durationMs: duration(1680),
					phase: "ongoing",
					keyframes: [
						{ offsetMs: at(0), value: { x: 0, y: 0 } },
						{ offsetMs: at(240), value: { x: 0.65, y: 0.75 } },
						{ offsetMs: at(1680), value: { x: 0, y: 0 } }
					],
					note: "Exit toward the overlook marker."
				}
			]
		},
		{
			kind: "raw_input",
			id: elementId("track_raw"),
			label: "Recorded input",
			observedAt: "raw_device",
			injectAt: "hardware",
			clips: [
				{
					kind: "raw_input",
					id: elementId("raw_stick"),
					label: "Left stick",
					device: "gamepad",
					key: "Gamepad_Left2D",
					startMs: at(760),
					durationMs: duration(2840),
					value: 0.96
				},
				{
					kind: "raw_input",
					id: elementId("raw_face_bottom"),
					label: "Face button bottom",
					device: "gamepad",
					key: "Gamepad_FaceButton_Bottom",
					startMs: at(2910),
					durationMs: duration(110),
					value: 1
				}
			]
		},
		{
			kind: "world_conditions",
			id: elementId("track_world"),
			label: "Game checks",
			observedAt: "gameplay_response",
			clips: [
				{
					kind: "world_condition",
					id: elementId("wait_landing_ready"),
					label: "LandingReady",
					operation: "WaitUntilActorReady",
					startMs: at(4100),
					timeoutMs: duration(1250),
					mode: "wait",
					expression: "BP_LandingVolume.State == Ready",
					blocking: true
				},
				{
					kind: "world_condition",
					id: elementId("probe_cache_open"),
					label: "Cache opened",
					operation: "ObserveGameplayTag",
					startMs: at(5580),
					timeoutMs: duration(420),
					mode: "probe",
					expression: "Scenario.Cache.State == Open",
					blocking: false
				}
			]
		},
		{
			kind: "interventions",
			id: elementId("track_interventions"),
			label: "Overrides",
			observedAt: "gameplay_response",
			clips: [
				{
					kind: "intervention",
					id: elementId("force_cache_loot"),
					label: "Force rare loot",
					startMs: at(5480),
					durationMs: duration(360),
					operation: "OverrideLootOutcome",
					payload: { rarity: "rare", table: "/Game/Fixture/Data/DT_ScenarioLoot" }
				}
			]
		},
		{
			kind: "evidence",
			id: elementId("track_evidence"),
			label: "Captures",
			observedAt: "gameplay_response",
			clips: [
				{
					kind: "evidence",
					id: elementId("marker_apex"),
					label: "Jump apex",
					startMs: at(3370),
					evidenceType: "screenshot",
					request: "CaptureFrame(Camera.Player, 1920x1080)"
				},
				{
					kind: "evidence",
					id: elementId("marker_cache_state"),
					label: "Cache state",
					startMs: at(5660),
					evidenceType: "world_state",
					request: "SnapshotActor(BP_ScenarioCache)"
				},
				{
					kind: "evidence",
					id: elementId("marker_exit_note"),
					label: "Exit line",
					startMs: at(7800),
					evidenceType: "note",
					request: "Confirm pawn crosses the painted overlook line."
				}
			]
		}
	]
};

export const movementGymRuns: readonly ScenarioRun[] = [
	{
		schemaVersion: 1,
		id: makeScenarioRunId("run_take-03"),
		scenarioId: movementGymScenario.id,
		label: "Take 03 · recorded",
		status: "completed_with_divergence",
		recordedAt: "2026-08-10T09:42:18.000Z",
		durationMs: duration(9380),
		engineVersion: "5.7",
		world: "L_MovementGym:PersistentLevel",
		evidence: [
			{
				id: elementId("evidence_apex_03"),
				markerId: elementId("marker_apex"),
				atMs: at(3490),
				type: "screenshot",
				label: "Jump apex",
				summary: "Pawn cleared the near edge; forward velocity remained 602 cm/s.",
				artifactUri: "evidence://run_take-03/apex.png",
				status: "captured"
			},
			{
				id: elementId("evidence_cache_03"),
				markerId: elementId("marker_cache_state"),
				atMs: at(5735),
				type: "world_state",
				label: "Cache state",
				summary: "The cache was open and the rare loot override was active.",
				artifactUri: "evidence://run_take-03/cache-state.json",
				status: "captured"
			}
		],
		divergences: [
			{
				id: elementId("divergence_jump_03"),
				atMs: at(3490),
				severity: "warning",
				source: "timing",
				expected: "Apex marker at 3370 ms",
				observed: "Jump happened 120 ms late",
				explanation: "The recorded jump fired one input frame after the timeline action."
			},
			{
				id: elementId("divergence_stream_03"),
				atMs: at(5710),
				severity: "info",
				source: "streaming",
				expected: "LandingReady within 800 ms",
				observed: "LandingReady took 1034 ms",
				explanation: "The level took longer to load, so the landing check finished late."
			}
		]
	},
	{
		schemaVersion: 1,
		id: makeScenarioRunId("run_take-02"),
		scenarioId: movementGymScenario.id,
		label: "Take 02 · baseline",
		status: "completed",
		recordedAt: "2026-08-10T09:37:04.000Z",
		durationMs: duration(9216),
		engineVersion: "5.7",
		world: "L_MovementGym:PersistentLevel",
		evidence: [],
		divergences: []
	}
];
