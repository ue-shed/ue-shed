import { ErrorGuidanceFields, type ErrorNextStep } from "@ue-shed/protocol";
import { type Brand, Schema } from "effect";

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

export class MapHistoryError extends Schema.TaggedError<
	MapHistoryError,
	Brand.Brand<"packages/map-history/src/errors/MapHistoryError">
>()("MapHistoryError", {
	kind: MapHistoryErrorKind,
	...ErrorGuidanceFields,
	message: Schema.NonEmptyString,
	recovery: Schema.NonEmptyString,
	cause: Schema.optionalKey(Schema.Defect())
}) {}

/**
 * The next step for a failure whose kind is only known at runtime. Range, scope, mapping and limit
 * failures need different input; transient Perforce, storage and decode failures may be retried
 * when the failed operation was a read; anything else needs someone with depot access.
 */
export function mapHistoryNextStep(kind: MapHistoryErrorKind, retrySafe: boolean): ErrorNextStep {
	switch (kind) {
		case "invalid_target":
		case "invalid_range":
		case "perforce_configuration":
		case "perforce_authentication":
		case "ambiguous_depot_mapping":
		case "ambiguous_map_lineage":
		case "map_lineage_limit":
		case "resource_limit":
		case "unsupported_history_layout":
		case "baseline_unavailable":
			return "fix_input";
		case "cancelled":
			return retrySafe ? "retry" : "reconcile";
		case "perforce_command":
		case "temporary_storage":
		case "saved_world_decode":
		case "materialization":
			return retrySafe ? "retry" : "escalate";
	}
}
