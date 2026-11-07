import { Schema } from "effect";
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
};
/** The cultures a selection picks: one, several, or none for every culture. */
export const pickedLocalizationCultures = (selection) => selection?.cultures ?? (selection?.culture === undefined ? [] : [selection.culture]);
/** The line fields the all-languages CSV reads; `selectLocalizationLines` exports only these. */
export const LOCALIZATION_LINES_CSV_FIELDS = [
    "origin",
    "identity",
    "source",
    "manifest",
    "audience",
    "marks",
    "places"
];
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
