import { Schema } from "effect";

export const MapHistoryErrorKind = Schema.Literals([
	"invalid_target",
	"invalid_range",
	"perforce_configuration",
	"perforce_authentication",
	"perforce_command",
	"ambiguous_depot_mapping",
	"ambiguous_map_lineage",
	"map_lineage_limit",
	"resource_limit",
	"materialization",
	"temporary_storage",
	"saved_world_decode",
	"baseline_unavailable",
	"unsupported_history_layout",
	"cancelled"
]);
export type MapHistoryErrorKind = Schema.Schema.Type<typeof MapHistoryErrorKind>;

export class MapHistoryError extends Schema.TaggedErrorClass<MapHistoryError>()("MapHistoryError", {
	kind: MapHistoryErrorKind,
	message: Schema.NonEmptyString,
	recovery: Schema.NonEmptyString,
	retrySafe: Schema.Boolean,
	cause: Schema.optionalKey(Schema.Defect())
}) {}
