import { describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import { LocalizationEvidence } from "@ue-shed/localization";
import type { SavedAssetPackageTextRecord } from "@ue-shed/unreal-assets";
import { GameTextIndexRefresh } from "./index-refresh.js";
import { makeIndexRegressionFixture } from "./index-refresh-regressions.test-support.js";
import { typeScriptIndexBuilderLayer } from "./index-reference.test-support.js";
import { joinLocalizationTarget } from "./localization.js";
import { nativeIndexBuilderLayer } from "./native-index-builder.js";
import { textCorpusQuery } from "./query.test-support.js";
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
							const localization = { target: fixture.target.name };
							// What each query decides must equal the in-memory query, groups included.
							const decided = (page: TextCorpusSearchPage) => ({
								total: page.total,
								lines: page.localization?.lines.map((line) => line.id),
								units: page.units.map((unit) => unit.id),
								problems: page.problems,
								counts: page.counts,
								groups: page.groups
							});
							const search = (
								scoped: boolean,
								patch: Partial<TextCorpusSearchRequest>
							) => {
								const request: TextCorpusSearchRequest = {
									query: "",
									capability: "all",
									pageSize: 50,
									...(scoped ? { localization } : undefined),
									...patch
								};
								return result
									.search(request)
									.pipe(
										Effect.tap((page) =>
											Effect.sync(() =>
												expect(
													decided(page),
													JSON.stringify(request)
												).toEqual(decided(inMemory.search(request)))
											)
										)
									);
							};
							const source = (op: "is" | "is_not", values: readonly string[]) =>
								({
									field: "source",
									op,
									values
								}) as const satisfies TextFilter[number];

							// Exact text: case and trailing space are other texts.
							const lines = yield* search(true, {
								filter: [source("is", ["Mushroom"])]
							});
							expect(lineKeys(lines)).toEqual(["Shop/Item", "UI/Header", "UI/Title"]);
							expect(
								unitSources(
									yield* search(false, { filter: [source("is", ["Mushroom"])] })
								)
							).toEqual(["Mushroom", "Mushroom", "Mushroom"]);
							expect(
								lineKeys(
									yield* search(true, {
										filter: [source("is", ["mushroom", "Mushroom ", "absent"])]
									})
								)
							).toEqual(["UI/Lower", "UI/Spaced"]);
							// A unit with conflicting sources has each of them.
							expect(
								unitSources(
									yield* search(false, { filter: [source("is", ["Blue cap"])] })
								)
							).toEqual(["Blue cap|Red cap"]);
							const all = (yield* search(true, {})).total;
							expect(
								(yield* search(true, {
									filter: [source("is_not", ["Mushroom", "Stem"])]
								})).total
							).toBe(all - 5);

							// Every stored signal filters: the key holding two texts conflicts.
							const conflicting = yield* search(true, {
								filter: [{ field: "finding", op: "is", values: ["conflicting"] }]
							});
							expect(lineKeys(conflicting)).toEqual(["UI/Cap"]);
							yield* search(false, {
								filter: [{ field: "finding", op: "is", values: ["evidence_only"] }]
							});

							// Texts under several keys, in one query.
							const shared = {
								filter: [
									{ field: "finding", op: "is", values: ["duplicate_source"] }
								] satisfies TextFilter,
								group: "source",
								minGroupSize: 2
							} as const;
							const groups = (yield* search(true, shared)).groups;
							expect(groups?.by).toBe("source");
							expect(
								groups?.entries.map((entry) => [
									entry.key,
									entry.label,
									entry.count
								])
							).toEqual([
								["Mushroom", "Mushroom", 3],
								["Stem", "Stem", 2]
							]);
							expect(groups?.more).toBe(0);
							expect(
								lineKeys(yield* search(true, { ...shared, openGroup: "Mushroom" }))
							).toEqual(["Shop/Item", "UI/Header", "UI/Title"]);
							// A larger minimum leaves smaller groups out, without counting them.
							const larger = (yield* search(true, { ...shared, minGroupSize: 3 }))
								.groups;
							expect(larger?.entries.map((entry) => entry.key)).toEqual(["Mushroom"]);
							expect(larger?.more).toBe(0);
							// Every text groups without a minimum, units too.
							yield* search(true, { group: "source" });
							yield* search(false, { group: "source", minGroupSize: 2 });
							yield* search(false, {
								group: "source",
								openGroup: "Blue cap",
								pageSize: 1
							});
							yield* search(true, { group: "asset", minGroupSize: 2 });
						}).pipe(
							Effect.provide(fixture.layer(false, fixture.source, false, builder))
						);
					})
				)
			);
		}, 120000);
});
