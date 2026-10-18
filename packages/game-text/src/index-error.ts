import { Schema } from "effect";
import { LocalizationError } from "@ue-shed/localization/browser";

/**
 * Failure to discover, prepare or orchestrate an index operation. operation identifies the
 * boundary, recovery guides the host, and the retained cause/localizationError preserves
 * lower-level evidence.
 */
export class GameTextIndexError extends Schema.TaggedError<GameTextIndexError>()(
	"GameTextIndexError",
	{
		nextStep: Schema.Literals(["fix_input", "retry", "reconcile", "escalate"]),
		code: Schema.Literal("index_failed"),
		operation: Schema.String,
		message: Schema.String,
		recovery: Schema.String,
		retrySafe: Schema.Boolean,
		localizationError: Schema.optionalKey(LocalizationError),
		cause: Schema.optionalKey(Schema.Defect())
	}
) {}
/** Tag guard for Game Text index failures; match by tag, not `instanceof`. */
export const isGameTextIndexError = Schema.is(GameTextIndexError);
