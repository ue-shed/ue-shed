import { Schema } from "effect";
import { ScenarioRun, type ScenarioDocument, type SemanticActionClip } from "./schema.js";

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));
const InputAxis = Schema.Finite.check(Schema.isBetween({ minimum: -1, maximum: 1 }));

export const SCENARIO_EXECUTION_CAPABILITIES = [
	"scenarios.execute.pie.v1",
	"scenarios.evidence.world-state.v1",
	"scenarios.input-isolation.slate.v1",
	"scenarios.input.pre-evaluation.v1"
] as const;

export const ScenarioWireContract = Schema.Struct({
	name: Schema.Literal("ue-shed-scenario-execution"),
	version: Schema.Struct({ major: Schema.Literal(1), minor: Schema.Literal(0) })
});
export type ScenarioWireContract = typeof ScenarioWireContract.Type;

export const scenarioWireContract = ScenarioWireContract.make({
	name: "ue-shed-scenario-execution",
	version: { major: 1, minor: 0 }
});

export const LiveScenarioActionId = Schema.Literals(["Move", "Jump", "Interact"]);
export type LiveScenarioActionId = typeof LiveScenarioActionId.Type;

export const LiveScenarioInputValue = Schema.TaggedUnion({
	Axis2D: { x: InputAxis, y: InputAxis },
	Boolean: { value: Schema.Boolean }
});
export type LiveScenarioInputValue = typeof LiveScenarioInputValue.Type;

export const LiveScenarioKeyframe = Schema.Struct({
	atMs: NonNegativeInt,
	value: LiveScenarioInputValue
});
export type LiveScenarioKeyframe = typeof LiveScenarioKeyframe.Type;

export const LiveScenarioAction = Schema.Struct({
	actionId: LiveScenarioActionId,
	actionPath: Schema.NonEmptyString,
	keyframes: Schema.Array(LiveScenarioKeyframe).check(Schema.isMinLength(1)),
	valueType: Schema.Literals(["Axis2D", "Boolean"])
});
export type LiveScenarioAction = typeof LiveScenarioAction.Type;

export const ScenarioExecutionRequest = Schema.Struct({
	contract: ScenarioWireContract,
	actions: Schema.Array(LiveScenarioAction).check(Schema.isMinLength(1)),
	durationMs: PositiveInt,
	evidenceLimit: PositiveInt,
	expectedPieSessionId: Schema.NonEmptyString,
	injectionLayer: Schema.Literal("pre_evaluation"),
	liveInputPolicy: Schema.Literal("isolated"),
	mapPath: Schema.NonEmptyString,
	probe: Schema.Struct({ atMs: NonNegativeInt, condition: Schema.Literal("cache_open") }),
	scenarioId: Schema.NonEmptyString,
	wait: Schema.Struct({
		atMs: NonNegativeInt,
		condition: Schema.Literal("landing_ready"),
		timeoutMs: PositiveInt
	})
});
export type ScenarioExecutionRequest = typeof ScenarioExecutionRequest.Type;

export const ScenarioPrepareResponse = Schema.TaggedUnion({
	Prepared: {
		contract: ScenarioWireContract,
		mapPath: Schema.NonEmptyString,
		scenarioId: Schema.NonEmptyString
	},
	Rejected: {
		code: Schema.String,
		contract: ScenarioWireContract,
		message: Schema.String,
		recovery: Schema.String
	}
});
export type ScenarioPrepareResponse = typeof ScenarioPrepareResponse.Type;

export const ScenarioStartResponse = Schema.TaggedUnion({
	Accepted: {
		contract: ScenarioWireContract,
		pieSessionId: Schema.NonEmptyString,
		runId: Schema.NonEmptyString,
		state: Schema.Literal("accepted")
	},
	Rejected: {
		code: Schema.String,
		contract: ScenarioWireContract,
		message: Schema.String,
		recovery: Schema.String
	}
});
export type ScenarioStartResponse = typeof ScenarioStartResponse.Type;

export const ScenarioStatusResponse = Schema.TaggedUnion({
	Active: {
		contract: ScenarioWireContract,
		gameTimeMs: NonNegativeInt,
		pieSessionId: Schema.NonEmptyString,
		runId: Schema.NonEmptyString,
		state: Schema.Literals(["accepted", "isolating", "running", "waiting", "cancelling"])
	},
	Rejected: {
		code: Schema.String,
		contract: ScenarioWireContract,
		message: Schema.String,
		recovery: Schema.String
	},
	Terminal: {
		contract: ScenarioWireContract,
		result: ScenarioRun
	}
});
export type ScenarioStatusResponse = typeof ScenarioStatusResponse.Type;

export const ScenarioCancelResponse = Schema.TaggedUnion({
	Accepted: { contract: ScenarioWireContract, runId: Schema.NonEmptyString },
	Rejected: {
		code: Schema.String,
		contract: ScenarioWireContract,
		message: Schema.String,
		recovery: Schema.String
	}
});
export type ScenarioCancelResponse = typeof ScenarioCancelResponse.Type;

export const decodeScenarioStartResponse = Schema.decodeUnknownEffect(ScenarioStartResponse);
export const decodeScenarioPrepareResponse = Schema.decodeUnknownEffect(ScenarioPrepareResponse);
export const decodeScenarioStatusResponse = Schema.decodeUnknownEffect(ScenarioStatusResponse);
export const decodeScenarioCancelResponse = Schema.decodeUnknownEffect(ScenarioCancelResponse);
export const decodeScenarioExecutionRequest = Schema.decodeUnknownEffect(ScenarioExecutionRequest);

const actionIdsByPath: Readonly<Record<string, LiveScenarioActionId>> = {
	"/Game/Fixture/Input/IA_Interact": "Interact",
	"/Game/Fixture/Input/IA_Jump": "Jump",
	"/Game/Fixture/Input/IA_Move": "Move"
};

function inputValue(
	value: SemanticActionClip["keyframes"][number]["value"]
): LiveScenarioInputValue {
	if (typeof value === "boolean") return LiveScenarioInputValue.cases.Boolean.make({ value });
	if (typeof value === "object") {
		return LiveScenarioInputValue.cases.Axis2D.make({ x: value.x, y: value.y });
	}
	throw new Error("Movement Gym does not register a one-dimensional live action.");
}

export function movementGymExecutionRequest(options: {
	readonly document: ScenarioDocument;
	readonly evidenceLimit: number;
	readonly pieSessionId: string;
}): ScenarioExecutionRequest {
	if (options.document.liveInputPolicy !== "isolated") {
		throw new Error("Live Movement Gym execution requires isolated input.");
	}
	const track = options.document.tracks.find(
		(candidate) => candidate.kind === "semantic_actions"
	);
	if (track === undefined || track.kind !== "semantic_actions") {
		throw new Error("Movement Gym requires one semantic action track.");
	}
	if (track.injectAt !== "pre_evaluation") {
		throw new Error(`Unsupported Movement Gym injection layer: ${track.injectAt}`);
	}
	const actions = track.clips.map((clip) => {
		const actionId = actionIdsByPath[clip.actionPath];
		if (actionId === undefined)
			throw new Error(`Unsupported Movement Gym action: ${clip.actionPath}`);
		const first = clip.keyframes[0];
		if (first === undefined)
			throw new Error(`Movement Gym action ${actionId} has no keyframes.`);
		const valueType = typeof first.value === "object" ? "Axis2D" : "Boolean";
		const expectedValueType = actionId === "Move" ? "Axis2D" : "Boolean";
		if (valueType !== expectedValueType) {
			throw new Error(
				`Movement Gym action ${actionId} requires ${expectedValueType} values.`
			);
		}
		const keyframes = clip.keyframes.map((keyframe) => ({
			atMs: clip.startMs + keyframe.offsetMs,
			value: inputValue(keyframe.value)
		}));
		if (keyframes.some((keyframe) => keyframe.value._tag !== expectedValueType)) {
			throw new Error(`Movement Gym action ${actionId} contains a mismatched value.`);
		}
		return LiveScenarioAction.make({
			actionId,
			actionPath: clip.actionPath,
			keyframes,
			valueType
		});
	});
	if (
		actions.length !== 4 ||
		actions.filter((action) => action.actionId === "Move").length !== 2 ||
		actions.filter((action) => action.actionId === "Jump").length !== 1 ||
		actions.filter((action) => action.actionId === "Interact").length !== 1 ||
		actions.reduce((count, action) => count + action.keyframes.length, 0) !== 11
	) {
		throw new Error("Movement Gym requires its exact registered four-clip action schedule.");
	}
	return ScenarioExecutionRequest.make({
		contract: scenarioWireContract,
		actions,
		durationMs: options.document.durationMs,
		evidenceLimit: options.evidenceLimit,
		expectedPieSessionId: options.pieSessionId,
		injectionLayer: "pre_evaluation",
		liveInputPolicy: "isolated",
		mapPath: options.document.mapPath,
		probe: { atMs: 5580, condition: "cache_open" },
		scenarioId: options.document.id,
		wait: { atMs: 4100, condition: "landing_ready", timeoutMs: 1250 }
	});
}
