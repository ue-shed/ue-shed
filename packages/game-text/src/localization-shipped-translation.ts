import { Schema } from "effect";
import type { LocalizationCultureState } from "./localization-schema.js";

export const LocalizationShippedTranslation = Schema.Struct({
	origin: Schema.Literals(["po", "archive", "absent"]),
	value: Schema.NullOr(Schema.String)
});

/**
 * Secondary not_synced facts matter even when drift or gathered_only is the primary state. Checks
 * ask for every culture of every line, so the value is built without validating it again: both
 * fields come from the typed culture state.
 */
export function localizationShippedTranslation(
	culture: LocalizationCultureState
): typeof LocalizationShippedTranslation.Type {
	if (culture.facts.includes("not_synced") || culture.state === "not_synced")
		return { origin: "po", value: culture.poTranslation };
	return {
		origin: culture.archive ? "archive" : "absent",
		value: culture.archive?.translation.Text ?? null
	};
}
