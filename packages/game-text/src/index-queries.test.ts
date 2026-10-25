import { describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import type { SavedAssetPackageTextRecord } from "@ue-shed/unreal-assets";
import { GameTextIndexRefresh } from "./index-refresh.js";
import { makeIndexRegressionFixture } from "./index-refresh-regressions.test-support.js";
import { typeScriptIndexBuilderLayer } from "./index-reference.test-support.js";
import { nativeIndexBuilderLayer } from "./native-index-builder.js";
import {
	MAX_TEXT_SOURCE_LENGTH,
	TextCorpusSearchRequest,
	TextFilterClause,
	type TextCorpusSearchPage,
	type TextFilter
} from "./schema.js";

type Occurrence = SavedAssetPackageTextRecord["occurrences"][number];

const executable = process.env.UE_SHED_UASSET_EXECUTABLE;

const text = (namespace: string, key: string, source: string, property: string): Occurrence => ({
	source,
	dev_notes: "",
	identity: { status: "resolved", namespace, key },
	location: {
		kind: "asset_property",
		object_path: "/Game/Text/Table.Table",
		class_path: "/Script/Engine.DataAsset",
		property_path: property
	},
	edit_capability: "read_only"
});

// "Mushroom" is saved under three keys; case and whitespace variants are other texts. UI/Cap has
// two copies with different text, so its key holds two texts.
const saved: Occurrence[] = [
	text("UI", "Title", "Mushroom", "Title"),
	text("UI", "Header", "Mushroom", "Header"),
	text("Shop", "Item", "Mushroom", "Item"),
	text("UI", "Lower", "mushroom", "Lower"),
	text("UI", "Spaced", "Mushroom ", "Spaced"),
	text("UI", "Cap", "Red cap", "CapA"),
	text("UI", "Cap", "Blue cap", "CapB"),
	text("UI", "Stem", "Stem", "Stem"),
	text("Shop", "Stem", "Stem", "ShopStem")
];

const lineKeys = (page: TextCorpusSearchPage) =>
	(page.localization?.lines ?? [])
		.map((line) =>
			line.identity ? `${line.identity.namespace}/${line.identity.key}` : line.id
		)
		.sort();
const unitSources = (page: TextCorpusSearchPage) =>
	page.units
		.map((unit) =>
			unit.source.status === "consistent" ? unit.source.value : unit.source.values.join("|")
		)
		.sort();

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

describe("index queries", () => {
	it("bounds source clauses and needs a group for a minimum group size", () => {
		const clause = Schema.is(TextFilterClause);
		const request = Schema.is(TextCorpusSearchRequest);
		const base = { query: "", capability: "all", pageSize: 1 } as const;
		expect(clause({ field: "source", op: "is", values: ["Mushroom", " x "] })).toBe(true);
		expect(clause({ field: "source", op: "is", values: [""] })).toBe(false);
		expect(clause({ field: "source", op: "is", values: [] })).toBe(false);
		expect(
			clause({ field: "source", op: "is", values: ["x".repeat(MAX_TEXT_SOURCE_LENGTH + 1)] })
		).toBe(false);
		expect(
			clause({
				field: "source",
				op: "is",
				values: Array.from({ length: 51 }, (_, index) => String(index))
			})
		).toBe(false);
		expect(
			clause({ field: "finding", op: "is", values: ["conflicting", "compiled_copy_differs"] })
		).toBe(true);
		expect(request({ ...base, group: "source", minGroupSize: 2 })).toBe(true);
		expect(request({ ...base, minGroupSize: 2 })).toBe(false);
		expect(request({ ...base, group: "source", minGroupSize: 0 })).toBe(false);
		expect(request({ ...base, group: "source", minGroupSize: 1.5 })).toBe(false);
	});

	for (const [name, builder] of builders)
		it(`answers exact source, signal and source-group queries through the ${name}`, async () => {
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const fixture = yield* makeIndexRegressionFixture();
						fixture.update(saved);
						yield* Effect.gen(function* () {
							const result = yield* (yield* GameTextIndexRefresh).refresh(
								fixture.request
							);
							const localization = { target: fixture.target.name };
							// What each query decides: rows, totals, problems and groups.
							const search = (
								scoped: boolean,
								patch: Partial<TextCorpusSearchRequest>
							) =>
								result
									.search({
										query: "",
										capability: "all",
										pageSize: 50,
										...(scoped ? { localization } : undefined),
										...patch
									})
									.pipe(
										Effect.map((page) => ({
											total: page.total,
											lines: lineKeys(page),
											units: page.units.map((unit) => unit.id),
											sources: unitSources(page),
											problems: Object.fromEntries(
												Object.entries(page.problems ?? {}).filter(
													([, count]) => count > 0
												)
											),
											groups: page.groups && {
												by: page.groups.by,
												more: page.groups.more,
												entries: page.groups.entries.map((entry) => [
													entry.key,
													entry.label,
													entry.count,
													entry.needWork,
													entry.worst
												])
											}
										}))
									);
							const source = (op: "is" | "is_not", values: readonly string[]) =>
								({
									field: "source",
									op,
									values
								}) as const satisfies TextFilter[number];
							// Every saved unit, and with the target, every line: UI/K is in the
							// manifest but no longer saved, so it changed since the gather; the
							// rest are not gathered.
							const units = [
								"unreal:Shop:Item",
								"unreal:Shop:Stem",
								"unreal:UI:Cap",
								"unreal:UI:Header",
								"unreal:UI:Lower",
								"unreal:UI:Spaced",
								"unreal:UI:Stem",
								"unreal:UI:Title"
							];
							const lines = [
								"Shop/Item",
								"Shop/Stem",
								"UI/Cap",
								"UI/Header",
								"UI/K",
								"UI/Lower",
								"UI/Spaced",
								"UI/Stem",
								"UI/Title"
							];
							const linesProblems = {
								conflicting_source: 1,
								not_gathered: 8,
								changed_since_gather: 1
							};
							const unitsProblems = { conflicting_source: 1, up_to_date: 7 };

							// Exact text: case and trailing space are other texts.
							const mushroom = yield* search(true, {
								filter: [source("is", ["Mushroom"])]
							});
							expect(mushroom).toMatchObject({
								total: 3,
								lines: ["Shop/Item", "UI/Header", "UI/Title"],
								problems: { not_gathered: 3 }
							});
							expect(
								yield* search(false, { filter: [source("is", ["Mushroom"])] })
							).toMatchObject({
								total: 3,
								units: ["unreal:Shop:Item", "unreal:UI:Header", "unreal:UI:Title"],
								sources: ["Mushroom", "Mushroom", "Mushroom"],
								problems: { up_to_date: 3 }
							});
							expect(
								yield* search(true, {
									filter: [source("is", ["mushroom", "Mushroom ", "absent"])]
								})
							).toMatchObject({ total: 2, lines: ["UI/Lower", "UI/Spaced"] });
							// A unit with conflicting sources has each of them.
							expect(
								yield* search(false, { filter: [source("is", ["Blue cap"])] })
							).toMatchObject({
								total: 1,
								units: ["unreal:UI:Cap"],
								sources: ["Blue cap|Red cap"],
								problems: { conflicting_source: 1 }
							});
							expect(yield* search(true, {})).toMatchObject({
								total: 9,
								lines,
								units,
								problems: linesProblems
							});
							expect(
								yield* search(true, {
									filter: [source("is_not", ["Mushroom", "Stem"])]
								})
							).toMatchObject({
								total: 4,
								lines: ["UI/Cap", "UI/K", "UI/Lower", "UI/Spaced"],
								problems: {
									conflicting_source: 1,
									not_gathered: 3,
									changed_since_gather: 1
								}
							});

							// Every stored fact filters: the key holding two texts conflicts.
							expect(
								yield* search(true, {
									filter: [{ field: "fact", op: "is", values: ["conflicting"] }]
								})
							).toMatchObject({
								total: 1,
								lines: ["UI/Cap"],
								problems: { conflicting_source: 1, not_gathered: 1 }
							});
							// Every saved place is read only, so every unit is evidence only.
							expect(
								yield* search(false, {
									filter: [{ field: "fact", op: "is", values: ["evidence_only"] }]
								})
							).toMatchObject({ total: 8, units, problems: unitsProblems });

							// Texts under several keys, in one query; groups are worst first, then
							// larger.
							const shared = { group: "source", minGroupSize: 2 } as const;
							const mushrooms = ["Mushroom", "Mushroom", 3, 3, "not_gathered"];
							const stems = ["Stem", "Stem", 2, 2, "not_gathered"];
							expect((yield* search(true, shared)).groups).toEqual({
								by: "source",
								more: 0,
								entries: [mushrooms, stems]
							});
							// Opening a group lists its lines and keeps the totals and groups.
							expect(
								yield* search(true, { ...shared, openGroup: "Mushroom" })
							).toMatchObject({
								total: 9,
								lines: ["Shop/Item", "UI/Header", "UI/Title"],
								problems: linesProblems,
								groups: { entries: [mushrooms, stems] }
							});
							// A larger minimum leaves smaller groups out, without counting them.
							expect(
								(yield* search(true, { ...shared, minGroupSize: 3 })).groups
							).toEqual({
								by: "source",
								more: 0,
								entries: [mushrooms]
							});
							// Every text groups without a minimum. A line with two texts is one
							// text, joined.
							expect(
								(yield* search(true, { group: "source" })).groups?.entries
							).toEqual([
								[
									"Red cap Blue cap",
									"Red cap Blue cap",
									1,
									1,
									"conflicting_source"
								],
								mushrooms,
								stems,
								["Mushroom ", "Mushroom ", 1, 1, "not_gathered"],
								["mushroom", "mushroom", 1, 1, "not_gathered"],
								["Source", "Source", 1, 1, "changed_since_gather"]
							]);
							// Units too; a unit with two texts groups under its first.
							expect(yield* search(false, shared)).toMatchObject({
								total: 8,
								units,
								groups: {
									more: 0,
									entries: [
										["Mushroom", "Mushroom", 3, 0, "up_to_date"],
										["Stem", "Stem", 2, 0, "up_to_date"]
									]
								}
							});
							expect(
								yield* search(false, {
									group: "source",
									openGroup: "Blue cap",
									pageSize: 1
								})
							).toMatchObject({
								total: 8,
								units: ["unreal:UI:Cap"],
								problems: unitsProblems,
								groups: {
									entries: [
										["Blue cap", "Blue cap", 1, 1, "conflicting_source"],
										["Mushroom", "Mushroom", 3, 0, "up_to_date"],
										["Stem", "Stem", 2, 0, "up_to_date"],
										["Mushroom ", "Mushroom ", 1, 0, "up_to_date"],
										["mushroom", "mushroom", 1, 0, "up_to_date"]
									]
								}
							});
							// Every line, the one K the manifest lists included, is in the one
							// package.
							expect(
								(yield* search(true, { group: "asset", minGroupSize: 2 })).groups
							).toEqual({
								by: "asset",
								more: 0,
								entries: [
									[
										"content/text/table",
										"Content/Text/Table",
										9,
										9,
										"conflicting_source"
									]
								]
							});
						}).pipe(Effect.provide(fixture.layer(fixture.source, builder)));
					})
				)
			);
		}, 120000);
});
