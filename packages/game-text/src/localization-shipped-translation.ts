import { Schema } from "effect";
import type { LocalizationCultureState } from "./localization-schema.js";

export const LocalizationShippedTranslation = Schema.Struct({
	origin: Schema.Literals(["po", "archive", "absent"]),
	value: Schema.NullOr(Schema.String)
});

/** Secondary not_synced facts matter even when drift or gathered_only is the primary state. */
export function localizationShippedTranslation(culture: LocalizationCultureState) {
	if (culture.facts.includes("not_synced") || culture.state === "not_synced")
		return LocalizationShippedTranslation.make({ origin: "po", value: culture.poTranslation });
	return LocalizationShippedTranslation.make({
		origin: culture.archive ? "archive" : "absent",
		value: culture.archive?.translation.Text ?? null
	});
}
