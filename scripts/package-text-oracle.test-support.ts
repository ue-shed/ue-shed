import type { TextCorpus } from "../packages/game-text/dist/index.js";
import type { Schema } from "effect";

type OracleValue = Schema.Json | TextCorpus["diagnostics"][number] | undefined;

function canonical(value: OracleValue): string {
	return (
		JSON.stringify(value, (_key, item: OracleValue) =>
			item instanceof Object && !Array.isArray(item)
				? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
				: item
		) ?? "<undefined>"
	);
}

/** Units match by stable ID. Occurrences, coverage and diagnostics are multisets; no fields are dropped. */
export function compareTextCorpora(
	expected: TextCorpus,
	actual: TextCorpus,
	maximumDifferences = 20
) {
	if (!Number.isSafeInteger(maximumDifferences) || maximumDifferences < 0)
		throw new Error("Difference limit must be a nonnegative integer.");
	const differences: { unit: string; field: string; expected: string; actual: string }[] = [];
	let differenceCount = 0;
	const record = (unit: string, field: string, left: OracleValue, right: OracleValue) => {
		const a = canonical(left),
			b = canonical(right);
		if (a === b) return;
		differenceCount++;
		if (differences.length < maximumDifferences)
			differences.push({ unit, field, expected: a.slice(0, 500), actual: b.slice(0, 500) });
	};
	const multiset = (values: readonly OracleValue[]) => values.map(canonical).sort();
	for (const field of ["schemaVersion", "status", "coverage"] as const)
		record("<corpus>", field, expected[field], actual[field]);
	for (const field of ["packageCoverage", "diagnostics"] as const)
		record("<corpus>", field, multiset(expected[field] ?? []), multiset(actual[field] ?? []));
	const left = new Map(expected.units.map((unit) => [unit.id, unit]));
	const right = new Map(actual.units.map((unit) => [unit.id, unit]));
	if (left.size !== expected.units.length)
		record(
			"<corpus>",
			"expected_duplicate_unit_id",
			"unique",
			expected.units.map((unit) => unit.id).sort()
		);
	if (right.size !== actual.units.length)
		record(
			"<corpus>",
			"actual_duplicate_unit_id",
			"unique",
			actual.units.map((unit) => unit.id).sort()
		);
	for (const id of new Set([...left.keys(), ...right.keys()])) {
		const a = left.get(id),
			b = right.get(id);
		if (!a || !b) {
			record(id, "unit", a, b);
			continue;
		}
		for (const field of ["identity", "source"] as const) record(id, field, a[field], b[field]);
		record(id, "occurrences", multiset(a.occurrences), multiset(b.occurrences));
	}
	return {
		equal: differenceCount === 0,
		differenceCount,
		differences,
		omittedDifferences: differenceCount - differences.length
	};
}

/** Eligibility mapping keeps full text equality, selected-package coverage equality and
 * an exact, explicit excluded set. Baseline gaps in excluded packages are audit evidence,
 * not claims that the selected reader inspected their payloads.
 */
export function compareTextCandidateCorpora(
	full: TextCorpus,
	selectedExpected: TextCorpus,
	actual: TextCorpus,
	excludedPackages: readonly string[]
) {
	const text = compareTextCorpora({ ...actual, units: full.units }, actual);
	const coverage = compareTextCorpora(selectedExpected, actual);
	const declared = (corpus: TextCorpus) =>
		(corpus.packageCoverage ?? [])
			.filter((item) => item.status === "not_gatherable")
			.map((item) => item.packageFile)
			.sort();
	const expectedExcluded = [...new Set(excludedPackages)].sort();
	const excludedEqual =
		canonical(declared(selectedExpected)) === canonical(expectedExcluded) &&
		canonical(declared(actual)) === canonical(expectedExcluded);
	return {
		equal: text.equal && coverage.equal && excludedEqual,
		differenceCount: text.differenceCount + coverage.differenceCount + Number(!excludedEqual),
		text,
		coverage,
		excludedEqual,
		excludedPackages: expectedExcluded
	};
}
