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
	type TextFilter
} from "./schema.js";
import { gatheredIdentity, gatheredIdentityKey } from "./gathered-text.js";

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

const markers = [
	"[029AE8344B5E8A6F3C1D2E4F5A6B7C8D]",
	"[1B2C3D4E5F60718293A4B5C6D7E8F901]",
	"[2C3D4E5F60718293A4B5C6D7E8F90123]"
] as const;

// Three copies of one Blueprint: their saved namespaces differ only by package marker, so Unreal
// gathers and translates all three as ("", "Title"), and they are one saved unit named by the
// first copy's saved identity.
const saved: Occurrence[] = [
	text(markers[0], "Title", "Mushroom", "CopyA"),
	text(markers[1], "Title", "Fungus", "CopyB"),
	text(markers[2], "Title", "Toadstool", "CopyC"),
	text(markers[0], "Subtitle", "Spores", "CopyA.Subtitle"),
	// A String Table entry keeps its table namespace: the same key text is another key.
	{
		...text("Mycology", "Title", "Mushroom table", "Title"),
		location: {
			kind: "string_table_entry",
			object_path: "/Game/Text/Table.Table",
			entry_key: "Title"
		}
	}
];

// The marker strips away: every copy's translation key is ["", "Title"].
const title = gatheredIdentityKey(gatheredIdentity(markers[1], "Title", false));
const subtitle = JSON.stringify(["", "Subtitle"]);
const tableTitle = JSON.stringify(["Mycology", "Title"]);

const keyClause = (op: "is" | "is_not", values: readonly string[]): TextFilter[number] => ({
	field: "translation_key",
	op,
	values
});

const unitKeys = (corpus: TextCorpus, page: TextCorpusSearchPage) =>
	page.units
		.map((unit) => {
			const found = corpus.units.find((item) => item.id === unit.id)!;
			return found.identity.status === "resolved"
				? `${found.identity.namespace}/${found.identity.key}`
				: found.id;
		})
		.sort();

const lineKeys = (page: TextCorpusSearchPage) =>
	(page.localization?.lines ?? [])
		.map((line) =>
			line.identity ? `${line.identity.namespace}/${line.identity.key}` : line.id
		)
		.sort();

/** What a filter decides on a page: rows, totals, problem counts and the origin facet. */
const decided = (corpus: TextCorpus, page: TextCorpusSearchPage) => ({
	total: page.total,
	units: unitKeys(corpus, page),
	lines: lineKeys(page),
	problems: Object.fromEntries(
		Object.entries(page.problems ?? {}).filter(([, count]) => count > 0)
	),
	origins: page.facets?.origins?.entries.map((entry) => [
		entry.key,
		entry.count,
		entry.needWork,
		entry.worst
	])
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

describe("translation_key filter", () => {
	it("accepts only JSON [namespace, key] values with a key", () => {
		const valid = Schema.is(TextFilterClause);
		expect(title).toBe('["","Title"]');
		expect(valid(keyClause("is", [title]))).toBe(true);
		for (const value of ['["","Title"] ', '["", "Title"]', '["UI",""]', '["UI"]', "UI,Title"])
			expect(valid(keyClause("is", [value])), value).toBe(false);
	});

	for (const [name, builder] of builders)
		it(`selects lines by gathered identity through the ${name}`, async () => {
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
							const localization = { target: fixture.target.name };
							const search = (filter: TextFilter, scoped: boolean) =>
								result
									.search({
										query: "",
										capability: "all",
										pageSize: 50,
										filter,
										facets: { origins: true },
										...(scoped ? { localization } : undefined)
									})
									.pipe(Effect.map((page) => decided(memory, page)));
							const copies = [`${markers[0]}/Title`];
							const subtitles = [`${markers[0]}/Subtitle`];

							// Without a target, the one unit holding every saved copy of the key,
							// whose copies conflict.
							expect(yield* search([keyClause("is", [title])], false)).toEqual({
								total: 1,
								units: copies,
								lines: [],
								problems: { conflicting_source: 1 },
								origins: [["asset", 1, 1, "conflicting_source"]]
							});
							// With one, the single line Unreal translates them by, which conflicts
							// and was never gathered.
							const lines = yield* search([keyClause("is", [title])], true);
							expect(lines).toEqual({
								total: 1,
								units: copies,
								lines: ["/Title"],
								problems: { conflicting_source: 1, not_gathered: 1 },
								origins: [["asset", 1, 1, "conflicting_source"]]
							});

							// Another key and the String Table entry stay out, and is_not keeps them.
							expect(yield* search([keyClause("is_not", [title])], false)).toEqual({
								total: 2,
								units: ["Mycology/Title", ...subtitles],
								lines: [],
								problems: { up_to_date: 2 },
								origins: [
									["asset", 1, 0, "up_to_date"],
									["string_table", 1, 0, "up_to_date"]
								]
							});
							// The target's manifest still lists UI/K, which is no longer saved.
							expect(yield* search([keyClause("is_not", [title])], true)).toEqual({
								total: 3,
								units: ["Mycology/Title", ...subtitles],
								lines: ["/Subtitle", "Mycology/Title", "UI/K"],
								problems: { not_gathered: 2, changed_since_gather: 1 },
								origins: [
									["asset", 2, 2, "not_gathered"],
									["string_table", 1, 1, "not_gathered"]
								]
							});
							expect(
								yield* search([keyClause("is", [subtitle, tableTitle])], true)
							).toEqual({
								total: 2,
								units: ["Mycology/Title", ...subtitles],
								lines: ["/Subtitle", "Mycology/Title"],
								problems: { not_gathered: 2 },
								origins: [
									["asset", 1, 1, "not_gathered"],
									["string_table", 1, 1, "not_gathered"]
								]
							});

							// Combined with other clauses, every clause must match; the problem
							// counts leave out the problem clause.
							const conflicting = {
								field: "problem",
								op: "is",
								values: ["conflicting_source"]
							} as const;
							expect(
								yield* search([keyClause("is", [title]), conflicting], false)
							).toEqual(yield* search([keyClause("is", [title])], false));
							expect(
								yield* search([keyClause("is", [title]), conflicting], true)
							).toEqual(lines);
							expect(
								yield* search([keyClause("is", [subtitle]), conflicting], true)
							).toEqual({
								total: 0,
								units: [],
								lines: [],
								problems: { not_gathered: 1 },
								origins: []
							});
							expect(
								yield* search(
									[
										keyClause("is", [title, subtitle]),
										{ field: "namespace", op: "is", values: [""] }
									],
									true
								)
							).toEqual({
								total: 2,
								units: [...subtitles, ...copies],
								lines: ["/Subtitle", "/Title"],
								problems: { conflicting_source: 1, not_gathered: 2 },
								origins: [["asset", 2, 2, "conflicting_source"]]
							});
						}).pipe(Effect.provide(fixture.layer(fixture.source, builder)));
					})
				)
			);
		}, 120000);
});
