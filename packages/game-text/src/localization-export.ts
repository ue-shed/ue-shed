import { Schema } from "effect";
import type { LocalizationSelection, LocalizationState } from "./localization-schema.js";
import type { LocalizationLineView } from "./index-reads.js";

/** The state names writers see, shared by every host that presents localization states. */
export const LOCALIZATION_STATE_LABELS = {
	translated: "Translated",
	not_translated: "Not translated",
	needs_update: "Needs update",
	not_synced: "Not synced",
	not_gathered: "Not gathered yet",
	changed_since_gather: "Changed since gather",
	not_found: "Not found in the project",
	gathered_only: "Gathered only",
	outside_target: "Outside this target",
	unknown: "Unknown"
} satisfies Record<LocalizationState, string>;

/** The cultures a selection picks: one, several, or none for every culture. */
export const pickedLocalizationCultures = (selection: LocalizationSelection | undefined) =>
	selection?.cultures ?? (selection?.culture === undefined ? [] : [selection.culture]);

/** The line fields the all-languages CSV reads; `selectLocalizationLines` exports only these. */
export const LOCALIZATION_LINES_CSV_FIELDS = [
	"origin",
	"identity",
	"source",
	"manifest",
	"audience",
	"marks",
	"places"
] as const;
/** A line as the all-languages CSV reads it, from `LOCALIZATION_LINES_CSV_FIELDS`. */
export type LocalizationCsvLine = LocalizationLineView<
	(typeof LOCALIZATION_LINES_CSV_FIELDS)[number]
>;

/** A host's result for exporting every matching line to a CSV the person chose. */
export const LocalizationLinesFileResult = Schema.Union([
	Schema.Struct({
		status: Schema.Literal("saved"),
		path: Schema.String,
		rowCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
	}),
	Schema.Struct({ status: Schema.Literal("cancelled") }),
	Schema.Struct({ status: Schema.Literal("not_ready") }),
	Schema.Struct({
		status: Schema.Literal("failed"),
		message: Schema.String,
		recovery: Schema.String
	})
]);
export type LocalizationLinesFileResult = typeof LocalizationLinesFileResult.Type;
