import { describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { LocalizationEvidence } from "@ue-shed/localization";
import type { SavedAssetPackageTextRecord } from "@ue-shed/unreal-assets";
import { GameTextIndexRefresh } from "./index-refresh.js";
import { makeIndexRegressionFixture } from "./index-refresh-regressions.test-support.js";
import { typeScriptIndexBuilderLayer } from "./index-reference.test-support.js";
import { joinLocalizationTarget } from "./localization.js";
import { LocalizationCultureMark } from "./localization-schema.js";
import { nativeIndexBuilderLayer } from "./native-index-builder.js";
import { textCorpusQuery } from "./query.test-support.js";
import type {
	TextCorpusSearchPage,
	TextCorpusSearchRequest,
	TextFilter,
	TextProblem,
	TextReviewSignal
} from "./schema.js";
import {
	countedFindings,
	textCountedFindings,
	textProblemCounts,
	textProblems
} from "./text-problems.js";
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

const finding = (...values: TextReviewSignal[]): TextFilter[number] => ({
	field: "finding",
	op: "is",
	values
});
const problem = (...values: TextProblem[]): TextFilter[number] => ({
	field: "problem",
	op: "is",
	values
});

// Requests with and without finding clauses: what counts as a finding follows each one.
const variants: readonly Pick<TextCorpusSearchRequest, "filter" | "lens">[] = [
	{},
	{ filter: [finding("long")] },
	{ filter: [finding("long", "shared")] },
	{ filter: [{ field: "finding", op: "is_not", values: ["long"] }] },
	{ lens: "long" },
	// Counts relax the lens and facets drop their own clause; neither changes what counts.
	{ lens: "long", filter: [problem("finding")] },
	{ lens: "long", filter: [finding("long")] },
	{ filter: [problem("finding")] },
	{ filter: [finding("long"), problem("finding")] },
	{ filter: [problem("unchecked")] },
	{ filter: [problem("changed_since_gather")] },
	{ filter: [problem("up_to_date")] }
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

/** A page's rows, totals, counts, facets, problems and groups, keyed by the line or unit key. */
function explained(page: TextCorpusSearchPage) {
	const rows = page.localization
		? page.localization.lines.map((line) => ({
				key: line.identity?.key ?? line.id,
				problems: line.problems,
				countedFindings: line.countedFindings
			}))
		: page.units.map((unit) => ({
				key: unit.identity.status === "resolved" ? unit.identity.key : unit.id,
				problems: unit.problems,
				countedFindings: unit.countedFindings
			}));
	return {
		rows: rows.sort((left, right) => left.key.localeCompare(right.key)),
		total: page.total,
		counts: page.counts,
		origins: page.facets?.origins,
		problems: page.problems,
		groups: page.groups?.entries.map((entry) => [entry.key, entry.count, entry.needWork])
	};
}

describe("text problems in the engine and textProblems", () => {
	it("maps states, facts, reasons and signals through the shared table", () => {
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
		expect(problems([mark("translated")], ["long"])).toEqual(["up_to_date"]);
		expect(problems([mark("translated")], ["shared"])).toEqual(["finding"]);
		expect(
			textProblems({
				signals: ["long"],
				keyChanged: false,
				countedFindings: countedFindings({ filter: [finding("long")] })
			})
		).toEqual(["finding"]);
		expect(
			countedFindings({ filter: [finding("conflicting", "long")], lens: "shared" })
		).toEqual(["shared", "duplicate_source", "long", "unresolved"]);
		expect(textCountedFindings(["long", "shared", "conflicting"])).toEqual(["shared"]);
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
							const memory = fixture.raw();
							const evidence = yield* Effect.gen(function* () {
								return yield* (yield* LocalizationEvidence).read({
									projectRoot: fixture.projectRoot,
									target: fixture.target
								});
							}).pipe(Effect.provide(fixture.evidence));
							const inMemory = textCorpusQuery(
								memory,
								undefined,
								joinLocalizationTarget(memory, evidence)
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
											...variant,
											...(group === undefined ? undefined : { group }),
											...(scoped
												? { localization: { target: fixture.target.name } }
												: undefined)
										};
										const label = JSON.stringify(request);
										const page = yield* result.search(request);
										// textProblems over the in-memory join decides every row.
										expect(explained(page), label).toEqual(
											explained(inMemory.search(request))
										);
										const counted = countedFindings(request);
										const rows = explained(page).rows;
										for (const row of rows)
											for (const item of row.problems!) seen.add(item);
										// A row has the problem its filter asked for, and shows
										// every finding that counted.
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
										for (const row of rows)
											expect(row.problems!.includes("finding"), label).toBe(
												row.countedFindings!.length > 0
											);
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
													marks: line.marks,
													countedFindings: counted
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
									"finding",
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
