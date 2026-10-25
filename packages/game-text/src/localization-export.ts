import { Schema } from "effect";
import { spreadsheetCsv } from "./csv.js";
import { localizationLineUnits } from "./gathered-text.js";
import type {
	LocalizationJoin,
	LocalizationLine,
	LocalizationSelection,
	LocalizationState
} from "./localization-schema.js";
import { localizationShippedTranslation } from "./localization-shipped-translation.js";
import type { TextCorpus } from "./schema.js";
import { TEXT_ORIGIN_LABELS, manifestOrigins, textLocationOrigin } from "./text-origin.js";
import { TEXT_AUDIENCE_LABELS } from "./text-audience-schema.js";
import { lineTextAudience, occurrenceTextAudience } from "./text-audience.js";
import { hasSearchableSource } from "./search.js";
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

// Code-unit order is the same on every machine, unlike locale collation.
const byCodeUnit = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

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

/**
 * One spreadsheet with every language: a row per line and, for the native culture first and then
 * the target's culture order, the translation that ships next and its state. Missing translations
 * are empty cells, so every language lines up by key. Picked cultures limit the columns to the
 * native culture and those. The CSV is for reading and sharing; edits go through PO change sets.
 * Pass lines read with `LOCALIZATION_LINES_CSV_FIELDS`, or whole lines and the corpus their
 * units come from.
 * @deprecated The engine writes this CSV: `NativeTextQuery.writeLocalizationLinesCsv`. Kept until
 * hosts adopt it.
 */
export function localizationLinesCsv(input: {
	readonly join: Pick<LocalizationJoin, "nativeCulture" | "cultures">;
	readonly lines: readonly (LocalizationLine | LocalizationCsvLine)[];
	readonly corpus?: TextCorpus | undefined;
	readonly cultures?: readonly string[] | undefined;
}) {
	const { join, lines } = input;
	const units = new Map(input.corpus?.units.map((unit) => [unit.id, unit]));
	type Line = LocalizationLine | LocalizationCsvLine;
	const wholeLine = (line: Line): line is LocalizationLine => !("places" in line);
	const picked =
		input.cultures === undefined || input.cultures.length === 0
			? undefined
			: new Set(input.cultures);
	const cultures = [
		...join.cultures.filter((culture) => culture === join.nativeCulture),
		...join.cultures.filter(
			(culture) =>
				culture !== join.nativeCulture && (picked === undefined || picked.has(culture))
		)
	];
	const placesOf = (line: Line) =>
		line.manifest.length > 0
			? line.manifest.map((entry) => entry.path)
			: wholeLine(line)
				? localizationLineUnits(line, units).flatMap((unit) =>
						unit.occurrences.map((occurrence) => occurrence.location.objectPath)
					)
				: line.places.map((place) => place.objectPath);
	const kindsOf = (line: Line) =>
		line.origin.kind === "corpus" && !wholeLine(line)
			? [...new Set(line.places.map((place) => place.origin))]
			: line.origin.kind === "corpus" && wholeLine(line) && units.size > 0
				? [
						...new Set(
							localizationLineUnits(line, units).flatMap((unit) =>
								unit.occurrences.map((occurrence) =>
									textLocationOrigin(occurrence.location)
								)
							)
						)
					]
				: manifestOrigins(line.manifest.map((entry) => entry.path));
	// Joins record the audience; recompute it for lines from older joins when the corpus is here.
	const audienceOf = (line: Line) =>
		line.audience ??
		lineTextAudience(
			localizationLineUnits(line, units)
				.filter(hasSearchableSource)
				.flatMap((unit) =>
					unit.occurrences.map(
						(occurrence) => occurrenceTextAudience(occurrence).audience
					)
				)
		);
	const shipped = (line: Line, culture: string) => {
		if (!wholeLine(line)) {
			const mark = line.marks.find((item) => item.culture === culture);
			return mark === undefined ? undefined : { value: mark.translation, state: mark.state };
		}
		const mark = line.cultures.find((item) => item.culture === culture);
		return mark === undefined
			? undefined
			: { value: localizationShippedTranslation(mark).value, state: mark.state };
	};
	const sorted = [...lines].sort(
		(left, right) =>
			byCodeUnit(left.identity?.namespace ?? "￿", right.identity?.namespace ?? "￿") ||
			byCodeUnit(left.identity?.key ?? "", right.identity?.key ?? "") ||
			byCodeUnit(left.source, right.source)
	);
	const header = [
		"Namespace",
		"Key",
		"Source",
		"Where",
		"Kind",
		"Audience",
		...cultures.flatMap((culture) => [culture, `${culture} state`])
	];
	const rows = sorted.map((line) => {
		const places = [...new Set(placesOf(line))];
		const where =
			places.length > 1 ? `${places[0]} (+${places.length - 1})` : (places[0] ?? "");
		return [
			line.identity?.namespace ?? "",
			line.identity?.key ?? "",
			line.manifest[0]?.source.Text ?? line.source,
			where,
			kindsOf(line)
				.map((kind) => TEXT_ORIGIN_LABELS[kind])
				.join(", "),
			TEXT_AUDIENCE_LABELS[audienceOf(line)],
			...cultures.flatMap((culture) => {
				const mark = shipped(line, culture);
				return mark === undefined
					? ["", ""]
					: [mark.value ?? "", LOCALIZATION_STATE_LABELS[mark.state]];
			})
		];
	});
	return { csv: spreadsheetCsv([header, ...rows]), rows: rows.length };
}

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
