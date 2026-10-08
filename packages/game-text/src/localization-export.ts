import { Schema } from "effect";
import { spreadsheetCsv } from "./csv.js";
import type {
	LocalizationJoin,
	LocalizationLine,
	LocalizationState
} from "./localization-schema.js";
import { localizationShippedTranslation } from "./localization-shipped-translation.js";
import type { TextCorpus } from "./schema.js";
import { TEXT_ORIGIN_LABELS, manifestOrigins, textLocationOrigin } from "./text-origin.js";

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

// Code-unit order is the same on every machine, unlike locale collation.
const byCodeUnit = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

/**
 * One spreadsheet with every language: a row per line and, for the native culture first and then
 * the target's culture order, the translation that ships next and its state. Missing translations
 * are empty cells, so every language lines up by key. The CSV is for reading and sharing; edits
 * go through PO change sets.
 */
export function localizationLinesCsv(input: {
	readonly join: LocalizationJoin;
	readonly lines: readonly LocalizationLine[];
	readonly corpus?: TextCorpus | undefined;
}) {
	const { join, lines } = input;
	const units = new Map(input.corpus?.units.map((unit) => [unit.id, unit]));
	const cultures = [
		...join.cultures.filter((culture) => culture === join.nativeCulture),
		...join.cultures.filter((culture) => culture !== join.nativeCulture)
	];
	const placesOf = (line: LocalizationLine) =>
		line.manifest.length > 0
			? line.manifest.map((entry) => entry.path)
			: line.origin.kind === "corpus"
				? line.origin.unitIds.flatMap(
						(id) =>
							units
								.get(id)
								?.occurrences.map((occurrence) => occurrence.location.objectPath) ??
							[]
					)
				: [];
	const kindsOf = (line: LocalizationLine) =>
		line.origin.kind === "corpus" && units.size > 0
			? [
					...new Set(
						line.origin.unitIds.flatMap(
							(id) =>
								units
									.get(id)
									?.occurrences.map((occurrence) =>
										textLocationOrigin(occurrence.location)
									) ?? []
						)
					)
				]
			: manifestOrigins(line.manifest.map((entry) => entry.path));
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
			...cultures.flatMap((culture) => {
				const mark = line.cultures.find((item) => item.culture === culture);
				return mark === undefined
					? ["", ""]
					: [
							localizationShippedTranslation(mark).value ?? "",
							LOCALIZATION_STATE_LABELS[mark.state]
						];
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
