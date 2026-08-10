import { Schema } from "effect";

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));

export const ScenarioId = Schema.String.pipe(Schema.brand("ScenarioId"));
export type ScenarioId = Schema.Schema.Type<typeof ScenarioId>;
export const makeScenarioId = ScenarioId.make;

export const ScenarioElementId = Schema.String.pipe(Schema.brand("ScenarioElementId"));
export type ScenarioElementId = Schema.Schema.Type<typeof ScenarioElementId>;
export const makeScenarioElementId = ScenarioElementId.make;

export const ScenarioRunId = Schema.String.pipe(Schema.brand("ScenarioRunId"));
export type ScenarioRunId = Schema.Schema.Type<typeof ScenarioRunId>;
export const makeScenarioRunId = ScenarioRunId.make;

export const TimelineTimeMs = NonNegativeInt.pipe(Schema.brand("TimelineTimeMs"));
export type TimelineTimeMs = Schema.Schema.Type<typeof TimelineTimeMs>;
export const makeTimelineTimeMs = TimelineTimeMs.make;

export const TimelineDurationMs = PositiveInt.pipe(Schema.brand("TimelineDurationMs"));
export type TimelineDurationMs = Schema.Schema.Type<typeof TimelineDurationMs>;
export const makeTimelineDurationMs = TimelineDurationMs.make;

export const InputInjectionLayer = Schema.Literals([
	"hardware",
	"pre_evaluation",
	"evaluated_action"
]);
export type InputInjectionLayer = Schema.Schema.Type<typeof InputInjectionLayer>;

export const ObservationLayer = Schema.Literals([
	"raw_device",
	"mapped_value",
	"evaluated_action",
	"gameplay_response"
]);
export type ObservationLayer = Schema.Schema.Type<typeof ObservationLayer>;

export const Axis2DValue = Schema.Struct({
	x: Schema.Number,
	y: Schema.Number
});
export type Axis2DValue = Schema.Schema.Type<typeof Axis2DValue>;

export const ActionValue = Schema.Union([Schema.Boolean, Schema.Number, Axis2DValue]);
export type ActionValue = Schema.Schema.Type<typeof ActionValue>;

export const ActionKeyframe = Schema.Struct({
	offsetMs: TimelineTimeMs,
	value: ActionValue
});
export type ActionKeyframe = Schema.Schema.Type<typeof ActionKeyframe>;

export const SemanticActionClip = Schema.Struct({
	kind: Schema.Literal("semantic_action"),
	id: ScenarioElementId,
	label: Schema.String,
	actionPath: Schema.String,
	startMs: TimelineTimeMs,
	durationMs: TimelineDurationMs,
	phase: Schema.Literals(["started", "ongoing", "triggered", "completed"]),
	keyframes: Schema.Array(ActionKeyframe),
	note: Schema.String
});
export type SemanticActionClip = Schema.Schema.Type<typeof SemanticActionClip>;

export const RawInputClip = Schema.Struct({
	kind: Schema.Literal("raw_input"),
	id: ScenarioElementId,
	label: Schema.String,
	device: Schema.Literals(["keyboard", "mouse", "gamepad"]),
	key: Schema.String,
	startMs: TimelineTimeMs,
	durationMs: TimelineDurationMs,
	value: Schema.Number
});
export type RawInputClip = Schema.Schema.Type<typeof RawInputClip>;

export const WorldConditionClip = Schema.Struct({
	kind: Schema.Literal("world_condition"),
	id: ScenarioElementId,
	label: Schema.String,
	operation: Schema.String,
	startMs: TimelineTimeMs,
	timeoutMs: TimelineDurationMs,
	mode: Schema.Literals(["wait", "probe", "assert"]),
	expression: Schema.String,
	blocking: Schema.Boolean
});
export type WorldConditionClip = Schema.Schema.Type<typeof WorldConditionClip>;

export const EvidenceMarker = Schema.Struct({
	kind: Schema.Literal("evidence"),
	id: ScenarioElementId,
	label: Schema.String,
	startMs: TimelineTimeMs,
	evidenceType: Schema.Literals(["screenshot", "world_state", "trace", "log", "note"]),
	request: Schema.String
});
export type EvidenceMarker = Schema.Schema.Type<typeof EvidenceMarker>;

export const InterventionClip = Schema.Struct({
	kind: Schema.Literal("intervention"),
	id: ScenarioElementId,
	label: Schema.String,
	startMs: TimelineTimeMs,
	durationMs: TimelineDurationMs,
	operation: Schema.String,
	payload: Schema.Record(Schema.String, Schema.Unknown)
});
export type InterventionClip = Schema.Schema.Type<typeof InterventionClip>;

export type ScenarioClip =
	| SemanticActionClip
	| RawInputClip
	| WorldConditionClip
	| EvidenceMarker
	| InterventionClip;

export const SemanticActionTrack = Schema.Struct({
	kind: Schema.Literal("semantic_actions"),
	id: ScenarioElementId,
	label: Schema.String,
	observedAt: Schema.Literal("evaluated_action"),
	injectAt: InputInjectionLayer,
	clips: Schema.Array(SemanticActionClip)
});
export type SemanticActionTrack = Schema.Schema.Type<typeof SemanticActionTrack>;

export const RawInputTrack = Schema.Struct({
	kind: Schema.Literal("raw_input"),
	id: ScenarioElementId,
	label: Schema.String,
	observedAt: Schema.Literal("raw_device"),
	injectAt: Schema.Literal("hardware"),
	clips: Schema.Array(RawInputClip)
});
export type RawInputTrack = Schema.Schema.Type<typeof RawInputTrack>;

export const WorldConditionTrack = Schema.Struct({
	kind: Schema.Literal("world_conditions"),
	id: ScenarioElementId,
	label: Schema.String,
	observedAt: Schema.Literal("gameplay_response"),
	clips: Schema.Array(WorldConditionClip)
});
export type WorldConditionTrack = Schema.Schema.Type<typeof WorldConditionTrack>;

export const EvidenceTrack = Schema.Struct({
	kind: Schema.Literal("evidence"),
	id: ScenarioElementId,
	label: Schema.String,
	observedAt: Schema.Literal("gameplay_response"),
	clips: Schema.Array(EvidenceMarker)
});
export type EvidenceTrack = Schema.Schema.Type<typeof EvidenceTrack>;

export const InterventionTrack = Schema.Struct({
	kind: Schema.Literal("interventions"),
	id: ScenarioElementId,
	label: Schema.String,
	observedAt: Schema.Literal("gameplay_response"),
	clips: Schema.Array(InterventionClip)
});
export type InterventionTrack = Schema.Schema.Type<typeof InterventionTrack>;

export const ScenarioTrack = Schema.Union([
	SemanticActionTrack,
	RawInputTrack,
	WorldConditionTrack,
	EvidenceTrack,
	InterventionTrack
]);
export type ScenarioTrack = Schema.Schema.Type<typeof ScenarioTrack>;

export const ScenarioCheckpoint = Schema.Struct({
	id: ScenarioElementId,
	label: Schema.String,
	atMs: TimelineTimeMs,
	strategy: Schema.Literals(["restart_map", "save_game", "project_operation"]),
	restoreOperation: Schema.String
});
export type ScenarioCheckpoint = Schema.Schema.Type<typeof ScenarioCheckpoint>;

export const NonSeekableInterval = Schema.Struct({
	startMs: TimelineTimeMs,
	endMs: TimelineTimeMs,
	reason: Schema.String
});
export type NonSeekableInterval = Schema.Schema.Type<typeof NonSeekableInterval>;

export const ScenarioDocument = Schema.Struct({
	schemaVersion: Schema.Literal(1),
	id: ScenarioId,
	title: Schema.String,
	description: Schema.String,
	mapPath: Schema.String,
	durationMs: TimelineDurationMs,
	timePolicy: Schema.Literal("game_time"),
	liveInputPolicy: Schema.Literals(["isolated", "observe_only"]),
	seed: NonNegativeInt,
	tags: Schema.Array(Schema.String),
	setupOperations: Schema.Array(Schema.String),
	checkpoints: Schema.Array(ScenarioCheckpoint),
	nonSeekableIntervals: Schema.Array(NonSeekableInterval),
	tracks: Schema.Array(ScenarioTrack)
});
export type ScenarioDocument = Schema.Schema.Type<typeof ScenarioDocument>;

export const ScenarioEvidence = Schema.Struct({
	id: ScenarioElementId,
	markerId: ScenarioElementId,
	atMs: TimelineTimeMs,
	type: Schema.Literals(["screenshot", "world_state", "trace", "log", "note"]),
	label: Schema.String,
	summary: Schema.String,
	artifactUri: Schema.optional(Schema.String),
	status: Schema.Literals(["captured", "missing", "partial"])
});
export type ScenarioEvidence = Schema.Schema.Type<typeof ScenarioEvidence>;

export const ScenarioDivergence = Schema.Struct({
	id: ScenarioElementId,
	atMs: TimelineTimeMs,
	severity: Schema.Literals(["info", "warning", "material"]),
	source: Schema.Literals(["timing", "physics", "streaming", "network", "input", "unknown"]),
	expected: Schema.String,
	observed: Schema.String,
	explanation: Schema.String
});
export type ScenarioDivergence = Schema.Schema.Type<typeof ScenarioDivergence>;

export const ScenarioRun = Schema.Struct({
	schemaVersion: Schema.Literal(1),
	id: ScenarioRunId,
	scenarioId: ScenarioId,
	label: Schema.String,
	status: Schema.Literals([
		"recording",
		"running",
		"completed",
		"completed_with_divergence",
		"failed"
	]),
	recordedAt: Schema.String,
	durationMs: TimelineDurationMs,
	engineVersion: Schema.String,
	world: Schema.String,
	evidence: Schema.Array(ScenarioEvidence),
	divergences: Schema.Array(ScenarioDivergence)
});
export type ScenarioRun = Schema.Schema.Type<typeof ScenarioRun>;

export const decodeScenarioDocument = Schema.decodeUnknownEffect(ScenarioDocument);
export const decodeScenarioRun = Schema.decodeUnknownEffect(ScenarioRun);
