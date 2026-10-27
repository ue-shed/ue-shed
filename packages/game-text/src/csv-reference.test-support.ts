import type { TextCorpus, TextIdentity, TextLocation, TextReviewSignal } from "./schema.js";
import { hasSearchableSource } from "./search.js";
import { TEXT_AUDIENCE_LABELS } from "./text-audience-schema.js";
import { occurrenceTextAudience } from "./text-audience.js";
import { spreadsheetCsv, textReviewSignalLabel, textLocationLabel, textAssetName } from "./csv.js";
function identityCells(identity: TextIdentity): readonly string[] {
	if (identity.status === "resolved") return [identity.key, identity.namespace || "global"];
	if (identity.status === "string_table") return [identity.key, identity.tableId];
	return ["", ""];
}
function locationCells(location: TextLocation): readonly string[] {
	return [
		textLocationLabel(location),
		textAssetName(location.objectPath),
		location.kind === "data_table_cell"
			? location.row
			: location.kind === "string_table_entry"
				? location.entryKey
				: "",
		location.kind === "string_table_entry" ? "" : location.propertyPath
	];
}
/** Independent CSV oracle for native-writer conformance tests. */
export function referenceCorpusCsv(
	corpus: Pick<TextCorpus, "units">,
	reviewSignals: ReadonlyMap<TextCorpus["units"][number]["id"], readonly TextReviewSignal[]>,
	findings?: {
		readonly labels: ReadonlyMap<string, string>;
		readonly units: ReadonlyMap<TextCorpus["units"][number]["id"], readonly string[]>;
	}
): string {
	return spreadsheetCsv(
		(function* () {
			yield [
				"Source",
				"Translator notes",
				"Key",
				"Namespace / string table",
				"Localization",
				"Location type",
				"Asset",
				"Row / entry",
				"Property",
				"Editable",
				"Characters",
				"Words",
				"Review signals",
				...(findings ? ["Findings"] : []),
				"Audience",
				"Text unit ID",
				"Package file"
			];
			for (const unit of corpus.units.filter(hasSearchableSource)) {
				const signals = reviewSignals.get(unit.id);
				if (signals === undefined)
					throw new Error(
						"CSV export is missing native review signals for a selected unit."
					);
				const ruleLabels = (findings?.units.get(unit.id) ?? []).map(
					(rule) => findings?.labels.get(rule) ?? rule
				);
				for (const occurrence of unit.occurrences) {
					yield [
						occurrence.source,
						occurrence.devNotes,
						...identityCells(occurrence.identity),
						occurrence.identity.status === "unresolved"
							? occurrence.identity.reason === "culture_invariant"
								? "Not localized (culture invariant)"
								: "Missing localization key"
							: "Localizable",
						...locationCells(occurrence.location),
						occurrence.editCapability === "source_editable" ? "Yes" : "No",
						occurrence.source.length,
						occurrence.source.trim() === ""
							? 0
							: occurrence.source.trim().split(/\s+/u).length,
						signals
							.filter((signal) => signal !== "evidence_only")
							.map(textReviewSignalLabel)
							.join("; "),
						...(findings ? [ruleLabels.join("; ")] : []),
						TEXT_AUDIENCE_LABELS[occurrenceTextAudience(occurrence).audience],
						unit.id,
						occurrence.packageFile
					];
				}
			}
		})()
	);
}
