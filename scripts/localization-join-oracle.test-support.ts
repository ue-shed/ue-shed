import type { LocalizationJoin, LocalizationLine } from "../packages/game-text/dist/index.js";
import type { Schema } from "effect";

type OracleValue = Schema.Json | undefined;

export interface JoinDifference {
	readonly line: string;
	readonly field: string;
	readonly expected: string;
	readonly actual: string;
}

/**
 * Lines match by stable line ID; their array order does not matter. Join.cultures order matters:
 * it is the target's display order. Per-line cultures match by culture, origin unit IDs, facts,
 * unknown reasons and review flags are sets. Manifest entries and key-change translations are
 * multisets (duplicates remain significant). Object key order is immaterial. Text, metadata array
 * order, PO comment order and previous-msgid line order remain significant. No data is dropped.
 */
export function compareLocalizationJoins(
	expected: LocalizationJoin,
	actual: LocalizationJoin,
	maximumDifferences = 20
) {
	if (!Number.isSafeInteger(maximumDifferences) || maximumDifferences < 0)
		throw new Error("Difference limit must be a nonnegative integer.");
	const differences: JoinDifference[] = [];
	const counts: Record<string, number> = {};
	let differenceCount = 0;
	const differentLines = new Set<string>();
	const record = (line: string, field: string, left: OracleValue, right: OracleValue) => {
		const a = canonical(left);
		const b = canonical(right);
		if (a === b) return;
		differenceCount++;
		differentLines.add(line);
		counts[field] = (counts[field] ?? 0) + 1;
		if (differences.length < maximumDifferences)
			differences.push({ line, field, expected: excerpt(a), actual: excerpt(b) });
	};
	for (const field of ["schemaVersion", "target", "nativeCulture", "cultures"] as const)
		record("<join>", field, expected[field], actual[field]);
	const left = indexLines(expected.lines, "expected", record);
	const right = indexLines(actual.lines, "actual", record);
	let matchedLines = 0;
	for (const [id, line] of left) {
		const other = right.get(id);
		if (other === undefined) {
			record(id, "missing_line", line.identity, "<absent>");
			continue;
		}
		matchedLines++;
		record(id, "identity", line.identity, other.identity);
		record(id, "source", line.source, other.source);
		record(id, "origin", origin(line), origin(other));
		record(id, "manifest", multiset(line.manifest), multiset(other.manifest));
		const cultures = new Map(line.cultures.map((culture) => [culture.culture, culture]));
		const others = new Map(other.cultures.map((culture) => [culture.culture, culture]));
		if (cultures.size !== line.cultures.length || others.size !== other.cultures.length)
			record(
				id,
				"cultureMultiplicity",
				line.cultures.map((culture) => culture.culture).sort(),
				other.cultures.map((culture) => culture.culture).sort()
			);
		for (const culture of new Set([...cultures.keys(), ...others.keys()])) {
			const a = cultures.get(culture);
			const b = others.get(culture);
			if (a === undefined || b === undefined) {
				record(id, `cultures.${culture}`, a, b);
				continue;
			}
			for (const field of [
				"state",
				"reducedSourceChecking",
				"archive",
				"po",
				"poTranslation"
			] as const)
				record(id, `cultures.${culture}.${field}`, a[field], b[field]);
			for (const field of ["facts", "unknownReasons"] as const)
				record(id, `cultures.${culture}.${field}`, set(a[field]), set(b[field]));
			record(id, `cultures.${culture}.review`, review(a.review), review(b.review));
		}
		record(id, "keyChange", keyChange(line), keyChange(other));
	}
	for (const [id, line] of right)
		if (!left.has(id)) record(id, "extra_line", "<absent>", line.identity);
	return {
		equal: differenceCount === 0,
		expectedLines: expected.lines.length,
		actualLines: actual.lines.length,
		matchedLines,
		differentLines: differentLines.size,
		differenceCount,
		counts,
		differences,
		omittedDifferences: differenceCount - differences.length,
		message: differences
			.map(
				(difference) =>
					`${difference.line} ${difference.field}: expected ${difference.expected}; actual ${difference.actual}`
			)
			.join("\n")
	};
}

function canonical(value: OracleValue): string {
	return (
		JSON.stringify(value, (_key, item: OracleValue) => {
			if (item instanceof Object && !Array.isArray(item))
				return Object.fromEntries(
					Object.entries(item).sort(([a], [b]) => a.localeCompare(b))
				);
			return item;
		}) ?? "<undefined>"
	);
}
const excerpt = (value: string) => (value.length > 500 ? value.slice(0, 500) + "…" : value);
const set = (values: readonly string[]) => [...new Set(values)].sort();
const multiset = (values: readonly OracleValue[]) => values.map(canonical).sort();
const origin = (line: LocalizationLine) =>
	line.origin.kind === "corpus"
		? { ...line.origin, unitIds: set(line.origin.unitIds) }
		: line.origin;
const review = (value: LocalizationLine["cultures"][number]["review"]) =>
	value !== undefined && value.status !== "not_reviewed"
		? { ...value, flags: set(value.flags) }
		: value;
const keyChange = (line: LocalizationLine) =>
	line.keyChange === undefined
		? undefined
		: { ...line.keyChange, translations: multiset(line.keyChange.translations) };

function indexLines(
	lines: readonly LocalizationLine[],
	side: string,
	record: (line: string, field: string, left: OracleValue, right: OracleValue) => void
) {
	const index = new Map<string, LocalizationLine>();
	for (const line of lines) {
		if (index.has(line.id))
			record(line.id, "duplicate_line_id", `<unique ${side}>`, `<duplicate ${side}>`);
		index.set(line.id, line);
	}
	return index;
}
