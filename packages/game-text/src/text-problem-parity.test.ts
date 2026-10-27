import { describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import type { SavedAssetPackageTextRecord } from "@ue-shed/unreal-assets";
import { GameTextIndexRefresh } from "./index-refresh.js";
import { makeIndexRegressionFixture } from "./index-refresh-regressions.test-support.js";
import { typeScriptIndexBuilderLayer } from "./index-reference.test-support.js";
import { LocalizationCultureMark } from "./localization-schema.js";
import { nativeIndexBuilderLayer } from "./native-index-builder.js";
import type {
	TextCorpusSearchPage,
	TextCorpusSearchRequest,
	TextFilter,
	TextProblem,
	TextReviewSignal
} from "./schema.js";
import { textProblemCounts, textProblems } from "./text-problems.js";
import { TEXT_PROBLEMS } from "./text-problem-rules.js";

type Occurrence = SavedAssetPackageTextRecord["occurrences"][number];

const executable = process.env.UE_SHED_UASSET_EXECUTABLE;

const text = (
	object: string,
	key: string | undefined,
	source: string,
	property = key ?? "Text"
): Occurrence => ({
	source,
	dev_notes: "",
	identity:
		key === undefined
			? { status: "unresolved", reason: "missing_key" }
			: { status: "resolved", namespace: "UI", key },
	location: {
		kind: "asset_property",
		object_path: object,
		class_path: "/Script/Engine.DataAsset",
		property_path: property
	},
	edit_capability: "read_only"
});

// The package Unreal gathered each key from.
const packageOf = (key: string) =>
	key === "K" || key === "Gone"
		? "Table.Table"
		: key === "Partial"
			? "Partial.Partial"
			: key === "DupB"
				? "BP_B.BP_B"
				: "BP_A.BP_A";
const LONG = "A sentence long enough to be flagged as long text by Game Text.";
// Unreal's manifest and archives for the target: what was gathered and translated.
const gathered: readonly { key: string; source: string; translation?: string }[] = [
	{ key: "K", source: "Source", translation: "Shipped" },
	{ key: "Changed", source: "Old text", translation: "Alt" },
	{ key: "Gone", source: "Removed text", translation: "Weg" },
	{ key: "Partial", source: "Partly read", translation: "Teils" },
	{ key: "Long", source: LONG, translation: "Lang" },
	{ key: "Shared", source: "Shared text", translation: "Geteilt" },
	{ key: "DupA", source: "Same words", translation: "Gleich" },
	{ key: "DupB", source: "Same words", translation: "Gleich" },
	{ key: "Conflict", source: "First", translation: "Erst" },
	{ key: "Untranslated", source: "No translation yet", translation: "" }
];

// Packages beside the main Table package. Partial.uasset was read only partly and lost its text,
// so UI/Partial cannot be proven absent; UI/Gone's package (Table) was read completely.
const packages = [
	{
		path: "Content/Text/BP_A.uasset",
		occurrences: [
			text("/Game/Text/BP_A.BP_A", "Changed", "New text"),
			text("/Game/Text/BP_A.BP_A", "Long", LONG),
			text("/Game/Text/BP_A.BP_A", "Shared", "Shared text"),
			text("/Game/Text/BP_A.BP_A", "DupA", "Same words"),
			text("/Game/Text/BP_A.BP_A", "Conflict", "First"),
			text("/Game/Text/BP_A.BP_A", undefined, "No key here"),
			text("/Game/Text/BP_A.BP_A", "New", "Not gathered yet"),
			text("/Game/Text/BP_A.BP_A", "Untranslated", "No translation yet")
		]
	},
	{
		path: "Content/Text/BP_B.uasset",
		occurrences: [
			text("/Game/Text/BP_B.BP_B", "Shared", "Shared text"),
			text("/Game/Text/BP_B.BP_B", "DupB", "Same words"),
			text("/Game/Text/BP_B.BP_B", "Conflict", "Second")
		]
	},
	{
		path: "Content/Text/Partial.uasset",
		status: "partial" as const,
		occurrences: [text("/Game/Text/Partial.Partial", "Other", "Kept text")]
	}
];

const fact = (...values: TextReviewSignal[]): TextFilter[number] => ({
	field: "fact",
	op: "is",
	values
});
const problem = (...values: TextProblem[]): TextFilter[number] => ({
	field: "problem",
	op: "is",
	values
});

// Text without a key, as a row key.
const NO_KEY = "(no key)";
// Each row's problems. Without a target only the key with two texts has one. With it, UI/Changed
// has other text than Unreal gathered and UI/Gone left the completely read Table; UI/New and
// UI/Other were never gathered; the partly read package leaves UI/Partial unchecked, as text
// without a key is; the PO files are empty, so no translation is synced, and UI/Untranslated
// has none.
const unitProblems = new Map(
	Object.entries({
		Changed: ["up_to_date"],
		Conflict: ["conflicting_source"],
		DupA: ["up_to_date"],
		DupB: ["up_to_date"],
		K: ["up_to_date"],
		Long: ["up_to_date"],
		New: ["up_to_date"],
		[NO_KEY]: ["up_to_date"],
		Other: ["up_to_date"],
		Shared: ["up_to_date"],
		Untranslated: ["up_to_date"]
	} satisfies Record<string, readonly TextProblem[]>)
);
const lineProblems = new Map(
	Object.entries({
		Changed: ["changed_since_gather"],
		Conflict: ["conflicting_source", "unchecked"],
		DupA: ["translation"],
		DupB: ["translation"],
		Gone: ["changed_since_gather"],
		K: ["translation"],
		Long: ["translation"],
		New: ["not_gathered"],
		Other: ["not_gathered"],
		Partial: ["unchecked"],
		[NO_KEY]: ["unchecked"],
		Shared: ["translation"],
		Untranslated: ["translation"]
	} satisfies Record<string, readonly TextProblem[]>)
);
const allUnits = [...unitProblems.keys()];
const allLines = [...lineProblems.keys()];
type ProblemCounts = Partial<Record<TextProblem, number>>;
const unitCounts = { conflicting_source: 1, up_to_date: 10 };
const lineCounts = {
	conflicting_source: 1,
	not_gathered: 2,
	changed_since_gather: 2,
	translation: 6,
	unchecked: 3
};

// Requests with fact and problem clauses, the rows each selects without a target and with one,
// and its problem counts, which leave out a problem clause. Without a findings layer no row has
// a finding, so a `finding` clause or problem selects none.
const variants: readonly {
	readonly filter?: TextFilter;
	readonly units: readonly string[];
	readonly lines: readonly string[];
	readonly problems: readonly [ProblemCounts, ProblemCounts];
}[] = [
	{ units: allUnits, lines: allLines, problems: [unitCounts, lineCounts] },
	{
		filter: [fact("unresolved")],
		units: [NO_KEY],
		lines: [NO_KEY],
		problems: [{ up_to_date: 1 }, { unchecked: 1 }]
	},
	{
		filter: [fact("unresolved", "conflicting")],
		units: ["Conflict", NO_KEY],
		lines: ["Conflict", NO_KEY],
		problems: [
			{ conflicting_source: 1, up_to_date: 1 },
			{ conflicting_source: 1, unchecked: 2 }
		]
	},
	{
		filter: [{ field: "fact", op: "is_not", values: ["unresolved"] }],
		units: allUnits.filter((key) => key !== NO_KEY),
		lines: allLines.filter((key) => key !== NO_KEY),
		problems: [
			{ conflicting_source: 1, up_to_date: 9 },
			{ ...lineCounts, unchecked: 2 }
		]
	},
	{ filter: [problem("finding")], units: [], lines: [], problems: [unitCounts, lineCounts] },
	{
		filter: [fact("conflicting"), problem("conflicting_source")],
		units: ["Conflict"],
		lines: ["Conflict"],
		problems: [{ conflicting_source: 1 }, { conflicting_source: 1, unchecked: 1 }]
	},
	{
		filter: [problem("unchecked")],
		units: [],
		lines: ["Conflict", "Partial", NO_KEY],
		problems: [unitCounts, lineCounts]
	},
	{
		filter: [problem("changed_since_gather")],
		units: [],
		lines: ["Changed", "Gone"],
		problems: [unitCounts, lineCounts]
	},
	{
		filter: [problem("up_to_date")],
		units: allUnits.filter((key) => key !== "Conflict"),
		lines: [],
		problems: [unitCounts, lineCounts]
	}
];

const builders = [
	["columnar reference", typeScriptIndexBuilderLayer],
	...(executable
		? [
				[
					"native engine",
					nativeIndexBuilderLayer({
						executable,
						timeoutMs: 30000,
						catalogTimeoutMs: 120000
					})
				] as const
			]
		: [])
] as const;

/** A page's rows and their problems, keyed by the line or unit key, and its totals and groups. */
function explained(page: TextCorpusSearchPage) {
	const rows = page.localization
		? page.localization.lines.map((line) => ({
				key: line.identity?.key ?? NO_KEY,
				problems: line.problems,
				findings: line.findings
			}))
		: page.units.map((unit) => ({
				key: unit.identity.status === "resolved" ? unit.identity.key : NO_KEY,
				problems: unit.problems,
				findings: unit.findings
			}));
	return {
		rows,
		problemsByKey: Object.fromEntries(rows.map((row) => [row.key, row.problems])),
		total: page.total,
		counts: page.counts,
		origins: page.facets?.origins?.entries.map((entry) => [
			entry.key,
			entry.count,
			entry.needWork,
			entry.worst
		]),
		problems: Object.fromEntries(
			Object.entries(page.problems ?? {}).filter(([, count]) => count > 0)
		),
		groups: page.groups?.entries.map(
			(entry) => [entry.key, entry.count, entry.needWork] as const
		)
	};
}

describe("text problems in the engine and textProblems", () => {
	it("maps states, facts and reasons through the shared table", () => {
		const mark = (state: string, unknownReasons: string[] = [], facts: string[] = []) =>
			Schema.decodeUnknownSync(LocalizationCultureMark)({
				culture: "de",
				state,
				facts,
				unknownReasons,
				reducedSourceChecking: false
			});
		const problems = (marks: LocalizationCultureMark[], signals: TextReviewSignal[] = []) =>
			textProblems({ signals, keyChanged: false, marks });
		expect(problems([mark("not_found")])).toEqual(["changed_since_gather"]);
		expect(problems([mark("unknown", ["package_partial"])])).toEqual(["unchecked"]);
		expect(problems([mark("unknown", ["conflicting_source"])])).toEqual([
			"conflicting_source",
			"unchecked"
		]);
		expect(problems([mark("translated", [], ["not_synced"])])).toEqual(["translation"]);
		expect(problems([mark("gathered_only")])).toEqual(["up_to_date"]);
		// Facts raise only `conflicting_source`; `finding` comes from the rules that count.
		expect(problems([mark("translated")], ["unresolved"])).toEqual(["up_to_date"]);
		expect(problems([mark("translated")], ["conflicting"])).toEqual(["conflicting_source"]);
		expect(textProblems({ signals: ["unresolved"], keyChanged: false, finding: true })).toEqual(
			["finding"]
		);
		expect(TEXT_PROBLEMS.indexOf("unchecked")).toBe(TEXT_PROBLEMS.length - 2);
	});

	for (const [name, builder] of builders)
		it(`reports the same problems for every line through the ${name}`, async () => {
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const fixture = yield* makeIndexRegressionFixture();
						const manifest = {
							FormatVersion: 1,
							Namespace: "UI",
							Children: gathered.map((line) => ({
								Source: { Text: line.source },
								Keys: [
									{
										Key: line.key,
										Path: `/Game/Text/${packageOf(line.key)}.${line.key}`
									}
								]
							}))
						};
						const archive = {
							FormatVersion: 2,
							Namespace: "UI",
							Children: gathered.flatMap((line) =>
								line.translation === undefined
									? []
									: [
											{
												Key: line.key,
												Source: { Text: line.source },
												Translation: { Text: line.translation }
											}
										]
							)
						};
						yield* Effect.promise(async () => {
							await writeFile(
								join(fixture.projectRoot, "Review.manifest"),
								JSON.stringify(manifest)
							);
							for (const culture of fixture.target.cultures) {
								await writeFile(
									join(fixture.projectRoot, `${culture}.archive`),
									JSON.stringify(archive)
								);
								await writeFile(join(fixture.projectRoot, `${culture}.po`), "");
							}
						});
						fixture.addPackages(packages);
						yield* Effect.gen(function* () {
							const result = yield* (yield* GameTextIndexRefresh).refresh(
								fixture.request
							);
							const seen = new Set<TextProblem>();
							for (const scoped of [false, true])
								for (const variant of variants)
									for (const group of [undefined, "problem" as const]) {
										const request: TextCorpusSearchRequest = {
											query: "",
											capability: "all",
											pageSize: 50,
											facets: { origins: true },
											...(variant.filter === undefined
												? undefined
												: { filter: variant.filter }),
											...(group === undefined ? undefined : { group }),
											...(scoped
												? { localization: { target: fixture.target.name } }
												: undefined)
										};
										const label = JSON.stringify(request);
										const page = yield* result.search(request);
										const found = explained(page);
										const keys = scoped ? variant.lines : variant.units;
										const table = scoped ? lineProblems : unitProblems;
										expect(found.problemsByKey, label).toEqual(
											Object.fromEntries(
												keys.map((key) => [key, table.get(key)])
											)
										);
										expect(found.total, label).toBe(keys.length);
										expect(found.problems, label).toEqual(
											variant.problems[scoped ? 1 : 0]
										);
										// Each row is in one group.
										if (group)
											expect(
												found.groups!.reduce(
													(sum, [, count]) => sum + count,
													0
												),
												label
											).toBe(keys.length);
										const rows = found.rows;
										for (const row of rows)
											for (const item of row.problems!) seen.add(item);
										// A row has the problem its filter asked for, and without
										// a findings layer neither a finding nor the problem.
										const asked: readonly string[] | undefined =
											request.filter?.find(
												(clause) => clause.field === "problem"
											)?.values;
										if (asked)
											for (const row of rows)
												expect(
													row.problems!.some((item) =>
														asked.includes(item)
													),
													label
												).toBe(true);
										for (const row of rows) {
											expect(row.problems!.includes("finding"), label).toBe(
												false
											);
											expect(row.findings, label).toBeUndefined();
										}
										if (variant.filter === undefined) {
											// Every row is a read-only asset property; one has no
											// key and one two texts.
											expect(found.counts, label).toMatchObject({
												all: keys.length,
												unresolved: 1,
												conflicting: 1,
												readOnly: keys.length
											});
											expect(found.origins, label).toEqual([
												[
													"asset",
													keys.length,
													scoped ? 11 : 1,
													"conflicting_source"
												]
											]);
											// Rows group by their worst problem; unchecked alone
											// needs no work.
											if (group)
												expect(found.groups, label).toEqual(
													scoped
														? [
																["conflicting_source", 1, 1],
																["not_gathered", 2, 2],
																["changed_since_gather", 2, 2],
																["translation", 6, 6],
																["unchecked", 2, 0]
															]
														: [
																["conflicting_source", 1, 1],
																["up_to_date", 10, 0]
															]
												);
										}
										if (!scoped || asked !== undefined) continue;
										// Every line, as the engine reads its inputs.
										const {
											pageSize: _size,
											group: _group,
											facets: _facets,
											...matching
										} = request;
										const lines = yield* result.query.selectLocalizationLines(
											matching,
											["problems", "signals", "marks", "keyChange"]
										);
										for (const line of lines)
											expect(line.problems, `${label} ${line.id}`).toEqual(
												textProblems({
													signals: line.signals,
													keyChanged: line.keyChange?.direction === "to",
													marks: line.marks
												})
											);
										expect(page.problems, label).toEqual(
											textProblemCounts(lines.map((line) => line.problems))
										);
									}
							expect([...seen].sort()).toEqual(
								[
									"changed_since_gather",
									"conflicting_source",
									"not_gathered",
									"translation",
									"unchecked",
									"up_to_date"
								].sort()
							);
						}).pipe(Effect.provide(fixture.layer(fixture.source, builder)));
					})
				)
			);
		});
});
