import type { TextCorpus, TextIdentity, TextLocation, TextReviewSignal } from "./schema.js";
import type { TextQualityFinding, TextQualityReport } from "./quality-schema.js";
import { textCorpusQuery } from "./query.js";
import { hasSearchableSource } from "./search.js";
import { TEXT_AUDIENCE_LABELS } from "./text-audience-schema.js";
import { occurrenceTextAudience } from "./text-audience.js";

/**
 * Human review copy for a stable signal code. Labels are presentation text; persisted filters
 * and integrations should retain the signal code instead.
 */
export function textReviewSignalLabel(signal: TextReviewSignal): string {
	switch (signal) {
		case "shared":
			return "used in several places";
		case "duplicate_source":
			return "same text under another key";
		case "long":
			return "long";
		case "unresolved":
			return "not localizable";
		case "conflicting":
			return "key has different text";
		case "evidence_only":
			return "read only";
		case "compiled_copy_differs":
			return "Blueprint not compiled since edit";
	}
}

/**
 * Human label for a saved occurrence's location kind. The original discriminated location
 * remains the machine-readable contract for navigation and editing decisions.
 */
export function textLocationLabel(location: TextLocation): string {
	switch (location.kind) {
		case "data_table_cell":
			return "Data table cell";
		case "string_table_entry":
			return "String table entry";
		case "asset_property":
			return "Asset property";
	}
}

function identityCells(identity: TextIdentity): readonly string[] {
	if (identity.status === "resolved") return [identity.key, identity.namespace || "global"];
	if (identity.status === "string_table") return [identity.key, identity.tableId];
	return ["", ""];
}

/** Exact authored object name used by the Content Browser. */
export function textAssetName(objectPath: string): string {
	const leaf = objectPath.split("/").at(-1) ?? objectPath;
	return leaf.split(".").at(-1) ?? leaf;
}

/**
 * Locale-formatted display count with simple singular/plural labeling. Use the numeric count
 * and stable domain codes for data processing rather than parsing this UI text.
 */
export function textCountLabel(count: number, singular: string): string {
	return `${count.toLocaleString()} ${singular}${count === 1 ? "" : "s"}`;
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

/** Human exports: quoted cells, BOM, final CRLF, and formula protection before whitespace. */
export function spreadsheetCsv(rows: Iterable<readonly (string | number)[]>): string {
	return (
		"\uFEFF" +
		[...rows]
			.map((row) =>
				row
					.map((cell) => {
						const text = String(cell);
						const value = /^\s*[=+\-@]/u.test(text) ? "'" + text : text;
						return '"' + value.replaceAll('"', '""') + '"';
					})
					.join(",")
			)
			.join("\r\n") +
		"\r\n"
	);
}

/** One row per searchable line's saved location. Optional context keeps scan-wide review signals. */
export function gameTextCsv(corpus: TextCorpus, reviewCorpus: TextCorpus = corpus): string {
	const query = textCorpusQuery(reviewCorpus);
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
				"Audience",
				"Text unit ID",
				"Package file"
			];
			for (const unit of corpus.units.filter(hasSearchableSource)) {
				const signals = query.focus({ id: unit.id, pageSize: 1 })?.unit.reviewSignals ?? [];
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
						TEXT_AUDIENCE_LABELS[occurrenceTextAudience(occurrence).audience],
						unit.id,
						occurrence.packageFile
					];
				}
			}
		})()
	);
}

/**
 * Formats a source finding's observed and expected values for display/CSV. Use the original
 * structured evidence and rule ID for programmatic decisions.
 */
export function textQualityProblem(finding: TextQualityFinding): string {
	if (finding.kind === "character_budget") {
		const limit = textCountLabel(finding.expectation.maximumCharacters, "character");
		const actual = textCountLabel(finding.actual.characterCount, "character");
		return `Maximum ${limit} · ${actual}`;
	}
	return finding.expectation.kind === "forbidden_term"
		? `Remove “${finding.actual.term}”`
		: `Prefer “${finding.expectation.preferredTerm}” · “${finding.actual.term}” at ${finding.actual.start}–${finding.actual.end}`;
}

/** One row for each finding and affected saved location. Corpus supplies Unreal keys. */
export function gameTextQualityCsv(report: TextQualityReport, corpus: TextCorpus): string {
	const units = new Map(corpus.units.map((unit) => [unit.id, unit]));
	return spreadsheetCsv(
		(function* () {
			yield [
				"Rule",
				"Role",
				"Check",
				"Problem",
				"Expected",
				"How to fix",
				"Source",
				"Key",
				"Namespace / string table",
				"Location type",
				"Asset",
				"Row / entry",
				"Property",
				"Text unit ID",
				"Package file"
			];
			for (const finding of report.findings) {
				const unit = units.get(finding.textUnitId);
				for (const affected of finding.affectedOccurrences) {
					const identity =
						unit?.occurrences.find((entry) => entry.id === affected.id)?.identity ??
						unit?.identity;
					const expected =
						finding.kind === "character_budget"
							? `Maximum ${textCountLabel(finding.expectation.maximumCharacters, "character")}`
							: finding.expectation.kind === "forbidden_term"
								? `Remove “${finding.expectation.term}”`
								: `Prefer “${finding.expectation.preferredTerm}”`;
					yield [
						finding.ruleId,
						finding.role,
						finding.kind === "character_budget" ? "Character limit" : "Terminology",
						textQualityProblem(finding),
						expected,
						finding.recovery,
						finding.actual.source,
						...(identity ? identityCells(identity) : ["", ""]),
						...locationCells(affected.location),
						finding.textUnitId,
						affected.packageFile
					];
				}
			}
		})()
	);
}
