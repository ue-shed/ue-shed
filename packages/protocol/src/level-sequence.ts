// Mirrors the published saved Level Sequence v6 record; checked by contract conformance.
import { Schema } from "effect";
import { SavedProperty } from "./uasset-inspection.js";
import { BlueprintGraphDiagnostic } from "./blueprint-graph.js";

export const SequenceRate = Schema.Struct({
	numerator: Schema.Int,
	denominator: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
}).annotate({ identifier: "SequenceRate" });
export interface SequenceRate extends Schema.Schema.Type<typeof SequenceRate> {}

export const SequenceBound = Schema.Struct({
	kind: Schema.Literals(["exclusive", "inclusive", "open"]),
	frame: Schema.Int
}).annotate({ identifier: "SequenceBound" });
export interface SequenceBound extends Schema.Schema.Type<typeof SequenceBound> {}

export const SequenceRange = Schema.Struct({
	lower: SequenceBound,
	upper: SequenceBound
}).annotate({ identifier: "SequenceRange" });
export interface SequenceRange extends Schema.Schema.Type<typeof SequenceRange> {}

export const SequenceTextKey = Schema.Struct({
	frame: Schema.Int,
	source: Schema.String,
	identity: Schema.Union([
		Schema.Struct({
			status: Schema.Literal("resolved"),
			namespace: Schema.String,
			key: Schema.String
		}),
		Schema.Struct({
			status: Schema.Literal("unresolved")
		})
	])
}).annotate({ identifier: "SequenceTextKey" });
export interface SequenceTextKey extends Schema.Schema.Type<typeof SequenceTextKey> {}

export const SequenceNumericKey = Schema.Struct({
	frame: Schema.Int,
	value: Schema.Finite,
	interpolation: Schema.Int.check(
		Schema.isGreaterThanOrEqualTo(0),
		Schema.isLessThanOrEqualTo(255)
	),
	tangent_mode: Schema.Int.check(
		Schema.isGreaterThanOrEqualTo(0),
		Schema.isLessThanOrEqualTo(255)
	),
	tangent_weight_mode: Schema.Int.check(
		Schema.isGreaterThanOrEqualTo(0),
		Schema.isLessThanOrEqualTo(255)
	),
	arrive_tangent: Schema.Finite,
	leave_tangent: Schema.Finite,
	arrive_tangent_weight: Schema.Finite,
	leave_tangent_weight: Schema.Finite
}).annotate({ identifier: "SequenceNumericKey" });
export interface SequenceNumericKey extends Schema.Schema.Type<typeof SequenceNumericKey> {}

export const SequenceNumericChannel = Schema.Struct({
	property_path: Schema.String,
	enabled: Schema.Union([Schema.Boolean, Schema.Null]),
	default_value: Schema.Union([Schema.Finite, Schema.Null]),
	pre_extrapolation: Schema.Int.check(
		Schema.isGreaterThanOrEqualTo(0),
		Schema.isLessThanOrEqualTo(255)
	),
	post_extrapolation: Schema.Int.check(
		Schema.isGreaterThanOrEqualTo(0),
		Schema.isLessThanOrEqualTo(255)
	),
	tick_resolution: SequenceRate,
	show_curve: Schema.Boolean,
	keys: Schema.Array(SequenceNumericKey).check(Schema.isMaxLength(1000000))
}).annotate({ identifier: "SequenceNumericChannel" });
export interface SequenceNumericChannel extends Schema.Schema.Type<typeof SequenceNumericChannel> {}

const discreteChannel = <const K extends string, S extends Schema.Top>(kind: K, value: S) =>
	Schema.Struct({
		value_type: Schema.Literal(kind),
		property_path: Schema.String,
		has_default_value: Schema.NullOr(Schema.Boolean),
		default_value: Schema.NullOr(value),
		pre_extrapolation: Schema.NullOr(Schema.String),
		post_extrapolation: Schema.NullOr(Schema.String),
		interpolate_linear_keys: Schema.NullOr(Schema.Boolean),
		externally_inverted: Schema.NullOr(Schema.Boolean),
		enum_path: Schema.NullOr(Schema.String),
		keys: Schema.NullOr(
			Schema.Array(
				Schema.Struct({
					frame: Schema.Int.check(
						Schema.isGreaterThanOrEqualTo(-2147483648),
						Schema.isLessThanOrEqualTo(2147483647)
					),
					value
				})
			).check(Schema.isMaxLength(1000000))
		)
	});

export const SequenceDiscreteChannel = Schema.Union([
	discreteChannel("bool", Schema.Boolean),
	discreteChannel(
		"integer",
		Schema.Int.check(
			Schema.isGreaterThanOrEqualTo(-2147483648),
			Schema.isLessThanOrEqualTo(2147483647)
		)
	),
	discreteChannel(
		"byte",
		Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(255))
	)
]).annotate({ identifier: "SequenceDiscreteChannel" });
export type SequenceDiscreteChannel = Schema.Schema.Type<typeof SequenceDiscreteChannel>;

const SavedFrame = Schema.Int.check(
	Schema.isGreaterThanOrEqualTo(-2147483648),
	Schema.isLessThanOrEqualTo(2147483647)
);

export const SequenceSectionSettings = Schema.Struct({
	row_index: Schema.NullOr(SavedFrame),
	overlap_priority: Schema.NullOr(SavedFrame),
	is_active: Schema.NullOr(Schema.Boolean),
	is_locked: Schema.NullOr(Schema.Boolean),
	pre_roll_frames: Schema.NullOr(SavedFrame),
	post_roll_frames: Schema.NullOr(SavedFrame),
	blend_type: Schema.NullOr(Schema.Array(SavedProperty).check(Schema.isMaxLength(1000000))),
	easing: Schema.NullOr(Schema.Array(SavedProperty).check(Schema.isMaxLength(1000000)))
}).annotate({ identifier: "SequenceSectionSettings" });
export type SequenceSectionSettings = Schema.Schema.Type<typeof SequenceSectionSettings>;
export const SequenceObjectValue = Schema.Struct({
	soft_path: Schema.NullOr(Schema.String),
	hard_path: Schema.NullOr(Schema.String)
});
export type SequenceObjectValue = Schema.Schema.Type<typeof SequenceObjectValue>;
const valueKeys = <S extends Schema.Top>(value: S) =>
	Schema.NullOr(
		Schema.Array(
			Schema.Struct({
				frame: Schema.Int.check(
					Schema.isGreaterThanOrEqualTo(-2147483648),
					Schema.isLessThanOrEqualTo(2147483647)
				),
				value
			})
		).check(Schema.isMaxLength(1000000))
	);
export const SequenceValueChannel = Schema.Union([
	Schema.Struct({
		value_type: Schema.Literal("string"),
		property_path: Schema.String,
		has_default_value: Schema.NullOr(Schema.Boolean),
		default_value: Schema.NullOr(Schema.String),
		keys: valueKeys(Schema.String)
	}),
	Schema.Struct({
		value_type: Schema.Literal("object"),
		property_path: Schema.String,
		property_class: Schema.NullOr(Schema.String),
		default_value: Schema.NullOr(SequenceObjectValue),
		keys: valueKeys(SequenceObjectValue)
	})
]).annotate({ identifier: "SequenceValueChannel" });
export type SequenceValueChannel = Schema.Schema.Type<typeof SequenceValueChannel>;
export const SequenceCameraCut = Schema.Struct({
	binding: Schema.NullOr(
		Schema.Struct({
			guid: Schema.NullOr(Schema.String),
			sequence_id: Schema.NullOr(SavedFrame),
			resolve_parent_index: Schema.NullOr(SavedFrame)
		})
	),
	lock_previous_camera: Schema.NullOr(Schema.Boolean)
}).annotate({ identifier: "SequenceCameraCut" });
export type SequenceCameraCut = Schema.Schema.Type<typeof SequenceCameraCut>;

export const SequenceSection = Schema.Struct({
	object_path: Schema.String,
	class_path: Schema.String,
	range: Schema.Union([SequenceRange, Schema.Null]),
	sequence_path: Schema.Union([Schema.String, Schema.Null]),
	shot_display_name: Schema.Union([Schema.String, Schema.Null]),
	text_keys: Schema.Array(SequenceTextKey).check(Schema.isMaxLength(1000000)),
	numeric_channels: Schema.Array(SequenceNumericChannel).check(Schema.isMaxLength(1000000)),
	discrete_channels: Schema.Array(SequenceDiscreteChannel).check(Schema.isMaxLength(1000000)),
	value_channels: Schema.Array(SequenceValueChannel).check(Schema.isMaxLength(1000000)),
	settings: SequenceSectionSettings,
	camera_cut: Schema.NullOr(SequenceCameraCut)
}).annotate({ identifier: "SequenceSection" });
export interface SequenceSection extends Schema.Schema.Type<typeof SequenceSection> {}

export const SequenceTrack = Schema.Struct({
	object_path: Schema.String,
	class_path: Schema.String,
	property_path: Schema.Union([Schema.String, Schema.Null]),
	content: Schema.Literals([
		"timed_text",
		"sub_sequence",
		"cinematic_shot",
		"numeric",
		"transform",
		"discrete",
		"value",
		"camera_cut",
		"structure_only"
	]),
	sections: Schema.Array(SequenceSection).check(Schema.isMaxLength(1000000))
}).annotate({ identifier: "SequenceTrack" });
export interface SequenceTrack extends Schema.Schema.Type<typeof SequenceTrack> {}

export const SequenceBinding = Schema.Struct({
	id: Schema.String,
	name: Schema.Union([Schema.String, Schema.Null]),
	possessed_object_class: Schema.Union([Schema.String, Schema.Null]),
	kind: Schema.Literals(["possessable", "spawnable", "unknown"]),
	parent_id: Schema.NullOr(Schema.String),
	object_template: Schema.NullOr(Schema.String),
	object_template_class: Schema.NullOr(Schema.String),
	tracks: Schema.Array(SequenceTrack).check(Schema.isMaxLength(1000000))
}).annotate({ identifier: "SequenceBinding" });
export interface SequenceBinding extends Schema.Schema.Type<typeof SequenceBinding> {}

export const SequenceReference = Schema.Struct({
	owner_path: Schema.String,
	owner_class_path: Schema.String,
	property_path: Schema.String,
	kind: Schema.Literals(["object", "soft_object", "data_table_row_handle"]),
	target_path: Schema.String,
	target_row: Schema.optionalKey(Schema.String),
	scope: Schema.Literals(["internal", "external"])
}).annotate({ identifier: "SequenceReference" });
export interface SequenceReference extends Schema.Schema.Type<typeof SequenceReference> {}

export const SequenceReferenceGap = Schema.Struct({
	owner_path: Schema.String,
	property_path: Schema.String,
	reason: Schema.Literals([
		"raw_property_value",
		"native_object_tail",
		"unresolved_object_reference"
	])
}).annotate({ identifier: "SequenceReferenceGap" });
export interface SequenceReferenceGap extends Schema.Schema.Type<typeof SequenceReferenceGap> {}

export const SequenceGap = Schema.Struct({
	object_path: Schema.String,
	property_path: Schema.String,
	reason: Schema.Literals([
		"missing_reference",
		"wrong_value_kind",
		"mismatched_channel_lengths",
		"unsupported_track_content",
		"unsupported_section_content",
		"missing_channel",
		"missing_channel_mask"
	])
}).annotate({ identifier: "SequenceGap" });
export interface SequenceGap extends Schema.Schema.Type<typeof SequenceGap> {}

export const LevelSequenceProjection = Schema.Struct({
	schema_version: Schema.Literal(6),
	object_path: Schema.String,
	movie_scene_path: Schema.Union([Schema.String, Schema.Null]),
	tick_resolution: Schema.Union([SequenceRate, Schema.Null]),
	display_rate: Schema.Union([SequenceRate, Schema.Null]),
	playback_range: Schema.Union([SequenceRange, Schema.Null]),
	bindings: Schema.Array(SequenceBinding).check(Schema.isMaxLength(1000000)),
	root_tracks: Schema.Array(SequenceTrack).check(Schema.isMaxLength(1000000)),
	references: Schema.Array(SequenceReference).check(Schema.isMaxLength(1000000)),
	reference_coverage_gaps: Schema.Array(SequenceReferenceGap).check(Schema.isMaxLength(1000000)),
	coverage_gaps: Schema.Array(SequenceGap).check(Schema.isMaxLength(1000000))
}).annotate({ identifier: "LevelSequenceProjection" });
export interface LevelSequenceProjection extends Schema.Schema.Type<
	typeof LevelSequenceProjection
> {}

export const LevelSequenceRead = Schema.Struct({
	sequence: LevelSequenceProjection,
	diagnostics: Schema.Array(BlueprintGraphDiagnostic),
	outcome: Schema.Literals(["complete", "partial"])
});
export interface LevelSequenceRead extends Schema.Schema.Type<typeof LevelSequenceRead> {}
