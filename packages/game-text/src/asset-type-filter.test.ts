import { describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import type { SavedAssetPackageTextRecord } from "@ue-shed/unreal-assets";
import { GameTextIndexRefresh } from "./index-refresh.js";
import { makeIndexRegressionFixture } from "./index-refresh-regressions.test-support.js";
import { typeScriptIndexBuilderLayer } from "./index-reference.test-support.js";
import { nativeIndexBuilderLayer } from "./native-index-builder.js";
import {
	TextFilterClause,
	type TextCorpus,
	type TextCorpusSearchPage,
	type TextCorpusSearchRequest,
	type TextFilter
} from "./schema.js";
import { textAssetTypeLabel } from "./text-asset-type.js";

type Occurrence = SavedAssetPackageTextRecord["occurrences"][number];

const executable = process.env.UE_SHED_UASSET_EXECUTABLE;

const types = {
	table: "/Script/Engine.DataTable",
	strings: "/Script/Engine.StringTable",
	widget: "/Script/UMGEditor.WidgetBlueprint",
	blueprint: "/Script/Engine.Blueprint",
	world: "/Script/Engine.World"
} as const;

const property = (object: string, key: string, source: string): Occurrence => ({
	source,
	dev_notes: "",
	identity: { status: "resolved", namespace: "UI", key },
	location: {
		kind: "asset_property",
		object_path: object,
		class_path: "/Script/Engine.DataAsset",
		property_path: key
	},
	edit_capability: "read_only"
});

// The main package, Content/Text/Table.uasset, is a DataTable holding the manifest's UI/K line.
const table: Occurrence = {
	source: "Source",
	dev_notes: "",
	identity: { status: "resolved", namespace: "UI", key: "K" },
	location: {
		kind: "data_table_cell",
		object_path: "/Game/Text/Table.Table",
		row: "Row_1",
		property_path: "Label"
	},
	edit_capability: "source_editable"
};

// Every package sits in the target's Content/Text gather path. UI/Shared is one unit saved in a
// Widget Blueprint and a Blueprint, so it has both types. The legacy package's reader predates
// asset classes, so its text has no type.
const packages = [
	{
		path: "Content/Text/ST_Menu.uasset",
		assetClass: types.strings,
		occurrences: [
			{
				...property("/Game/Text/ST_Menu.ST_Menu", "Start", "Start game"),
				identity: { status: "resolved", namespace: "Menu", key: "Start" },
				location: {
					kind: "string_table_entry",
					object_path: "/Game/Text/ST_Menu.ST_Menu",
					entry_key: "Start"
				}
			} satisfies Occurrence
		]
	},
	{
		path: "Content/Text/WBP_Hud.uasset",
		assetClass: types.widget,
		occurrences: [
			property("/Game/Text/WBP_Hud.WBP_Hud", "Hud", "Health"),
			property("/Game/Text/WBP_Hud.WBP_Hud", "Shared", "Shared text")
		]
	},
	{
		path: "Content/Text/BP_Door.uasset",
		assetClass: types.blueprint,
		occurrences: [
			property("/Game/Text/BP_Door.BP_Door", "Door", "Open door"),
			property("/Game/Text/BP_Door.BP_Door", "Shared", "Shared text")
		]
	},
	{
		// An actor saved in its own package has its world's type.
		path: "Content/Text/__ExternalActors__/L_Town/0/AB/Sign.uasset",
		assetClass: types.world,
		occurrences: [property("/Game/Text/L_Town.L_Town:PersistentLevel.Sign", "Welcome", "Hi")]
	},
	{
		path: "Content/Text/Legacy.uasset",
		occurrences: [property("/Game/Text/Legacy.Legacy", "Legacy", "Old text")]
	}
];

const typeClause = (op: "is" | "is_not", values: readonly string[]): TextFilter[number] => ({
	field: "asset_type",
	op,
	values
});

const keysOf = (corpus: TextCorpus, page: TextCorpusSearchPage) => ({
	units: page.units
		.map((unit) => {
			const found = corpus.units.find((item) => item.id === unit.id)!;
			return found.identity.status === "resolved" ? found.identity.key : found.id;
		})
		.sort(),
	lines: (page.localization?.lines ?? []).map((line) => line.identity?.key ?? line.id).sort()
});

/** What a filter decides on a page: rows, totals, problems and the asset type and origin facets. */
const decided = (corpus: TextCorpus, page: TextCorpusSearchPage) => ({
	total: page.total,
	...keysOf(corpus, page),
	problems: Object.fromEntries(
		Object.entries(page.problems ?? {}).filter(([, count]) => count > 0)
	),
	editable: [page.counts.editable, page.counts.readOnly],
	assetTypes: page.facets?.assetTypes?.entries.map((entry) => [
		entry.key,
		entry.label,
		entry.count
	]),
	origins: page.facets?.origins?.entries.map((entry) => [entry.key, entry.count, entry.worst])
});

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

describe("asset_type filter", () => {
	it("accepts class paths and reads them as sentence-case labels", () => {
		const valid = Schema.is(TextFilterClause);
		expect(valid(typeClause("is", [types.widget]))).toBe(true);
		expect(valid(typeClause("is", [""]))).toBe(false);
		expect(valid(typeClause("is", []))).toBe(false);
		expect(Object.values(types).map(textAssetTypeLabel)).toEqual([
			"Data table",
			"String table",
			"Widget blueprint",
			"Blueprint",
			"Level"
		]);
		expect(textAssetTypeLabel("/Script/Game.UIDataAsset")).toBe("UI data asset");
		expect(textAssetTypeLabel("/Script/Engine.Texture2D")).toBe("Texture2D");
		expect(textAssetTypeLabel("/Game/Items/BP_Item.BP_Item_C")).toBe("BP_Item");
	});

	for (const [name, builder] of builders)
		it(`selects text by its packages' asset types through the ${name}`, async () => {
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const fixture = yield* makeIndexRegressionFixture();
						fixture.patchRecord({ assetClass: types.table, occurrences: [table] });
						fixture.addPackages(packages);
						yield* Effect.gen(function* () {
							const result = yield* (yield* GameTextIndexRefresh).refresh(
								fixture.request
							);
							const memory = fixture.raw();
							const localization = { target: fixture.target.name };
							const request = (
								filter: TextFilter,
								scoped: boolean,
								pageSize = 50
							): TextCorpusSearchRequest => ({
								query: "",
								capability: "all",
								pageSize,
								filter,
								facets: { assetTypes: true, origins: true },
								...(scoped ? { localization } : undefined)
							});
							const search = (filter: TextFilter, scoped: boolean) =>
								result
									.search(request(filter, scoped))
									.pipe(Effect.map((page) => decided(memory, page)));

							for (const scoped of [false, true]) {
								const view = scoped ? "lines" : "units";
								const all = yield* search([], scoped);
								expect(all[view]).toEqual([
									"Door",
									"Hud",
									"K",
									"Legacy",
									"Shared",
									"Start",
									"Welcome"
								]);
								expect(all.total).toBe(7);
								expect(all.editable).toEqual([1, 6]);
								// The target's manifest gathers only UI/K.
								expect(all.problems).toEqual(
									scoped ? { not_gathered: 6, translation: 1 } : { up_to_date: 7 }
								);
								// Each type counts its lines; the Widget Blueprint and Blueprint
								// each count UI/Shared. The legacy package's text has no type.
								// Larger counts come first, then labels; with a target, worse lines
								// come first.
								const assetTypes = [
									[types.blueprint, "Blueprint", 2],
									[types.widget, "Widget blueprint", 2],
									...(scoped
										? [
												[types.world, "Level", 1],
												[types.strings, "String table", 1],
												[types.table, "Data table", 1]
											]
										: [
												[types.table, "Data table", 1],
												[types.world, "Level", 1],
												[types.strings, "String table", 1]
											])
								];
								expect(all.assetTypes).toEqual(assetTypes);
								expect(all.origins).toEqual(
									scoped
										? [
												["asset", 5, "not_gathered"],
												["string_table", 1, "not_gathered"],
												["data_table", 1, "translation"]
											]
										: [
												["asset", 5, "up_to_date"],
												["data_table", 1, "up_to_date"],
												["string_table", 1, "up_to_date"]
											]
								);
								const asset = (count: number) => [
									["asset", count, scoped ? "not_gathered" : "up_to_date"]
								];

								// `is` matches when any place has a selected type.
								const blueprints = yield* search(
									[typeClause("is", [types.blueprint])],
									scoped
								);
								expect(blueprints[view]).toEqual(["Door", "Shared"]);
								expect(blueprints.total).toBe(2);
								expect(blueprints.problems).toEqual(
									scoped ? { not_gathered: 2 } : { up_to_date: 2 }
								);
								expect(blueprints.origins).toEqual(asset(2));
								// The facet leaves out its own clause, so it still offers every type.
								expect(blueprints.assetTypes).toEqual(assetTypes);
								const either = yield* search(
									[typeClause("is", [types.widget, types.blueprint])],
									scoped
								);
								expect([either[view], either.total]).toEqual([
									["Door", "Hud", "Shared"],
									3
								]);
								expect(either.origins).toEqual(asset(3));
								const world = yield* search(
									[typeClause("is", [types.world])],
									scoped
								);
								expect([world[view], world.total]).toEqual([["Welcome"], 1]);

								// `is_not` matches when no place has one, so untyped text stays.
								const notBlueprints = yield* search(
									[typeClause("is_not", [types.blueprint])],
									scoped
								);
								expect([notBlueprints[view], notBlueprints.total]).toEqual([
									["Hud", "K", "Legacy", "Start", "Welcome"],
									5
								]);
								expect(notBlueprints.editable).toEqual([1, 4]);
								expect(notBlueprints.problems).toEqual(
									scoped ? { not_gathered: 4, translation: 1 } : { up_to_date: 5 }
								);
								expect(notBlueprints.assetTypes).toEqual(assetTypes);

								// Every clause must match; other clauses narrow the facet's counts.
								const combined = yield* search(
									[
										typeClause("is", [types.widget]),
										typeClause("is_not", [types.blueprint])
									],
									scoped
								);
								expect([combined[view], combined.total]).toEqual([["Hud"], 1]);
								expect(combined.origins).toEqual(asset(1));
								const origins = yield* search(
									[{ field: "origin", op: "is", values: ["data_table"] }],
									scoped
								);
								expect([origins[view], origins.total]).toEqual([["K"], 1]);
								expect(origins.editable).toEqual([1, 0]);
								expect(origins.assetTypes).toEqual([
									[types.table, "Data table", 1]
								]);
								expect(origins.origins).toEqual(all.origins);

								// Filtering happens before paging: totals cover every match.
								const paged = request(
									[typeClause("is", [types.widget, types.blueprint])],
									scoped,
									2
								);
								const first = yield* result.search(paged);
								expect(first.total).toBe(3);
								expect(keysOf(memory, first)[view]).toHaveLength(2);
								expect(
									scoped ? first.localization?.nextCursor : first.nextCursor
								).toBeDefined();
								const second = yield* result.search(
									scoped
										? {
												...paged,
												localizationCursor: first.localization!.nextCursor!
											}
										: { ...paged, cursor: first.nextCursor! }
								);
								expect(second.total).toBe(3);
								expect(
									[
										...keysOf(memory, first)[view],
										...keysOf(memory, second)[view]
									].sort()
								).toEqual(["Door", "Hud", "Shared"]);
							}

							// Exports select the same text as the search.
							const exported = yield* result.query.export(
								request([typeClause("is", [types.blueprint])], false)
							);
							expect(
								exported.units
									.map((unit) =>
										unit.identity.status === "resolved"
											? unit.identity.key
											: unit.id
									)
									.sort()
							).toEqual(["Door", "Shared"]);
							const lines = yield* result.query.localizationLines(
								request([typeClause("is_not", [types.blueprint])], true)
							);
							expect(lines.map((line) => line.identity?.key).sort()).toEqual([
								"Hud",
								"K",
								"Legacy",
								"Start",
								"Welcome"
							]);

							// A package read again with another main asset moves to that type.
							fixture.patchRecord({ assetClass: types.blueprint });
							const refreshed = yield* (yield* GameTextIndexRefresh).refresh(
								fixture.request
							);
							for (const scoped of [false, true]) {
								const page = yield* refreshed.search(
									request([typeClause("is", [types.blueprint])], scoped)
								);
								expect(keysOf(memory, page)[scoped ? "lines" : "units"]).toEqual([
									"Door",
									"K",
									"Shared"
								]);
								expect(
									page.facets?.assetTypes?.entries.some(
										(entry) => entry.key === types.table
									)
								).toBe(false);
							}
						}).pipe(Effect.provide(fixture.layer(fixture.source, builder)));
					})
				)
			);
		}, 120000);
});
