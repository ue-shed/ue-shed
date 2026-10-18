import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { expect } from "vitest";
import { LocalizationEvidence } from "@ue-shed/localization";
import type { SavedAssetPackageTextRecord } from "@ue-shed/unreal-assets";
import { GameTextIndexRefresh } from "./index-refresh.js";
import { makeIndexRegressionFixture } from "./index-refresh-regressions.test-support.js";
import { joinLocalizationTarget } from "./localization.js";
import { checkLocalizationTarget } from "./localization-checks.js";
import {
	localizationQualityWorkspace,
	localizationQualityWorkspaceOf
} from "./localization-workspace.js";
import { GameTextRuleDocument, evaluateGameTextSourceQuality } from "./game-text-rules.js";
import type { TextCorpus, TextLocation } from "./schema.js";

type Occurrence = SavedAssetPackageTextRecord["occurrences"][number];

// The fixture's one package is Content/Text/Table.uasset, Unreal's /Game/Text/Table. UE 4.27 saves
// `None` as its package name, so the reader names its objects relative to the package.
const occurrence = (key: string, source: string, location: Occurrence["location"]) =>
	({
		source,
		dev_notes: "",
		identity: { status: "resolved", namespace: "UI", key },
		location,
		edit_capability: "source_editable"
	}) satisfies Occurrence;
const saved = [
	occurrence("Label", "Label text", {
		kind: "asset_property",
		object_path: "Table",
		class_path: "/Script/Engine.DataAsset",
		property_path: "Label"
	}),
	occurrence("Title", "Title text", {
		kind: "asset_property",
		object_path: "Table:Widget",
		class_path: "Table_C",
		property_path: "Title"
	}),
	occurrence("Cell", "Cell text", {
		kind: "data_table_cell",
		object_path: "Table",
		row: "Row_1",
		property_path: "Name"
	}),
	occurrence("OtherCell", "Other cell", {
		kind: "data_table_cell",
		object_path: "Table",
		row: "Row_2",
		property_path: "Name"
	}),
	occurrence("Greeting", "Greeting text", {
		kind: "string_table_entry",
		object_path: "Table",
		entry_key: "Greeting"
	}),
	// A path Unreal saved in full is kept as it is.
	occurrence("Menu", "Menu text", {
		kind: "asset_property",
		object_path: "/Game/UI/Menu.Menu",
		class_path: "/Script/Engine.DataAsset",
		property_path: "Label"
	})
];
/** Unreal's own location for each saved occurrence, by key. */
const unrealLocations = {
	Label: {
		kind: "asset_property",
		objectPath: "/Game/Text/Table.Table",
		classPath: "/Script/Engine.DataAsset",
		propertyPath: "Label"
	},
	Title: {
		kind: "asset_property",
		objectPath: "/Game/Text/Table.Table:Widget",
		classPath: "/Game/Text/Table.Table_C",
		propertyPath: "Title"
	},
	Cell: {
		kind: "data_table_cell",
		objectPath: "/Game/Text/Table.Table",
		row: "Row_1",
		propertyPath: "Name"
	},
	OtherCell: {
		kind: "data_table_cell",
		objectPath: "/Game/Text/Table.Table",
		row: "Row_2",
		propertyPath: "Name"
	},
	Greeting: {
		kind: "string_table_entry",
		objectPath: "/Game/Text/Table.Table",
		entryKey: "Greeting"
	},
	Menu: {
		kind: "asset_property",
		objectPath: "/Game/UI/Menu.Menu",
		classPath: "/Script/Engine.DataAsset",
		propertyPath: "Label"
	}
} satisfies Record<string, TextLocation>;

const document = Schema.decodeUnknownSync(GameTextRuleDocument)({
	schemaVersion: 2,
	roles: [
		{
			id: "text_folder",
			scopes: [
				{ matchers: [{ kind: "object_path", operator: "prefix", value: "/Game/Text/" }] }
			]
		},
		{
			id: "table_asset",
			scopes: [
				{
					matchers: [
						{ kind: "object_path", operator: "exact", value: "/Game/Text/Table.Table" }
					]
				}
			]
		},
		{
			id: "widget_class",
			scopes: [
				{
					matchers: [
						{ kind: "class_path", operator: "exact", value: "/Game/Text/Table.Table_C" }
					]
				}
			]
		},
		{
			id: "first_row",
			scopes: [
				{
					matchers: [
						{ kind: "object_path", operator: "exact", value: "/Game/Text/Table.Table" },
						{ kind: "row", operator: "exact", value: "Row_1" }
					]
				}
			]
		},
		{
			id: "menu",
			scopes: [
				{ matchers: [{ kind: "object_path", operator: "prefix", value: "/Game/UI/" }] }
			]
		}
	],
	rules: ["text_folder", "table_asset", "widget_class", "first_row", "menu"].map((role) => ({
		id: `source.${role}`,
		kind: "character_budget",
		role,
		maximumCharacters: 3,
		recovery: "Shorten the line."
	})),
	localizationRules: [
		{
			id: "translation.first_row",
			kind: "localization_character_budget",
			role: "first_row",
			cultures: { de: 3 },
			recovery: "Shorten the translation."
		},
		{
			id: "translation.widget_class",
			kind: "localization_character_budget",
			role: "widget_class",
			cultures: { de: 3 },
			recovery: "Shorten the translation."
		}
	]
});
/** The keys each rule finds when roles see Unreal's paths. */
const expectedFindings = {
	"source.text_folder": ["Cell", "Greeting", "Label", "OtherCell", "Title"],
	"source.table_asset": ["Cell", "Greeting", "Label", "OtherCell"],
	"source.widget_class": ["Title"],
	"source.first_row": ["Cell"],
	"source.menu": ["Menu"]
};

/** A keyed unit's key; a keyless unit's source. */
const keyOf = (corpus: TextCorpus, id: string) => {
	const unit = corpus.units.find((item) => item.id === id)!;
	return unit.identity.status === "resolved" ? unit.identity.key : unit.occurrences[0]!.source;
};
const locationsByKey = (corpus: TextCorpus) =>
	Object.fromEntries(
		corpus.units.flatMap((unit) =>
			unit.occurrences.map((item) => [keyOf(corpus, unit.id), item.location] as const)
		)
	);

/** Writes the target's manifest, archives and PO files: German is too long for the budgets. */
async function writeLocalization(projectRoot: string) {
	const keys = saved.map((item) => ({
		key: item.identity.key,
		source: item.source,
		de: `Deutsch ${item.source}`
	}));
	await writeFile(
		join(projectRoot, "Review.manifest"),
		JSON.stringify({
			FormatVersion: 1,
			Namespace: "UI",
			Children: keys.map(({ key, source }) => ({
				Source: { Text: source },
				Keys: [{ Key: key, Path: `/Game/Text/Table.Table.${key}` }]
			}))
		})
	);
	for (const culture of ["en", "de"] as const) {
		await writeFile(
			join(projectRoot, `${culture}.archive`),
			JSON.stringify({
				FormatVersion: 2,
				Namespace: "UI",
				Children: keys.map(({ key, source, de }) => ({
					Key: key,
					Source: { Text: source },
					Translation: { Text: culture === "en" ? source : de }
				}))
			})
		);
		await writeFile(
			join(projectRoot, `${culture}.po`),
			keys
				.map(
					({ key, source, de }) =>
						`msgctxt "UI,${key}"\nmsgid "${source}"\nmsgstr "${culture === "en" ? source : de}"\n`
				)
				.join("\n")
		);
	}
}

it.live("units read from the index carry Unreal's object paths for every location kind", () =>
	Effect.gen(function* () {
		const fixture = yield* makeIndexRegressionFixture();
		// A keyless text's unit is identified by its object path.
		const invariant = {
			...occurrence("", "Invariant", {
				kind: "asset_property",
				object_path: "Table",
				class_path: "/Script/Engine.DataAsset",
				property_path: "Note"
			}),
			identity: { status: "unresolved", reason: "culture_invariant" }
		} satisfies Occurrence;
		fixture.update([...saved, invariant]);
		const expected = {
			...unrealLocations,
			Invariant: { ...unrealLocations.Label, propertyPath: "Note" }
		};
		yield* Effect.gen(function* () {
			const result = yield* (yield* GameTextIndexRefresh).refresh(fixture.request);
			// The in-memory corpus is built from the reader's records without the index.
			const memory = fixture.raw();
			expect(locationsByKey(memory)).toEqual(expected);
			expect(locationsByKey(yield* result.corpus)).toEqual(expected);
			expect((yield* result.corpus).units).toEqual(memory.units);
			expect(
				memory.units.find((unit) => unit.identity.status === "unresolved")!.id
			).toContain(":/Game/Text/Table.Table:");
			// Search reads its contexts and path filters from the stored columns.
			const page = yield* result.search({
				query: "",
				capability: "all",
				pageSize: 50,
				where: { pathPrefix: "/Game/Text/Table.Table" }
			});
			expect(page.units.map((unit) => keyOf(memory, unit.id)).sort()).toEqual([
				"Cell",
				"Greeting",
				"Invariant",
				"Label",
				"OtherCell",
				"Title"
			]);
			const byKey = new Map(Object.entries(expected));
			for (const unit of page.units)
				expect(unit.contexts.map((context) => context.location)).toEqual([
					byKey.get(keyOf(memory, unit.id))
				]);
		}).pipe(Effect.provide(fixture.layer()));
	}).pipe(Effect.scoped)
);

it.live("object path, class path and row roles match through the index and in memory", () =>
	Effect.gen(function* () {
		const fixture = yield* makeIndexRegressionFixture();
		yield* Effect.promise(() => writeLocalization(fixture.projectRoot));
		fixture.update(saved);
		yield* Effect.gen(function* () {
			const result = yield* (yield* GameTextIndexRefresh).refresh(fixture.request);
			const memory = fixture.raw();
			const source = evaluateGameTextSourceQuality(yield* result.corpus, document);
			expect(source.roles).toEqual([
				{ role: "first_row", matchedOccurrences: 1, matchedTextUnits: 1 },
				{ role: "menu", matchedOccurrences: 1, matchedTextUnits: 1 },
				{ role: "table_asset", matchedOccurrences: 4, matchedTextUnits: 4 },
				{ role: "text_folder", matchedOccurrences: 5, matchedTextUnits: 5 },
				{ role: "widget_class", matchedOccurrences: 1, matchedTextUnits: 1 }
			]);
			const found: Record<string, string[]> = {};
			for (const finding of source.findings)
				(found[finding.ruleId] ??= []).push(keyOf(memory, finding.textUnitId));
			for (const keys of Object.values(found)) keys.sort();
			expect(found).toEqual(expectedFindings);
			expect(source).toEqual(evaluateGameTextSourceQuality(memory, document));

			// Localization rules, checked over the index, against a join of the in-memory corpus.
			const evidence = yield* Effect.gen(function* () {
				return yield* (yield* LocalizationEvidence).read({
					projectRoot: fixture.projectRoot,
					target: fixture.target
				});
			}).pipe(Effect.provide(fixture.evidence));
			const memoryJoin = joinLocalizationTarget(memory, evidence);
			const legacy = localizationQualityWorkspace(
				evaluateGameTextSourceQuality(memory, document),
				checkLocalizationTarget(memory, memoryJoin, evidence, {}, document),
				memoryJoin
			);
			const quality = yield* result.localizationQuality(document);
			const translated = quality.findings
				.items(Array.from({ length: quality.findings.length }, (_, position) => position))
				.flatMap(({ finding }) =>
					finding.kind === "localization_character_budget"
						? [[finding.ruleId, finding.identity.key, finding.culture]]
						: []
				)
				.sort();
			expect(translated).toEqual([
				["translation.first_row", "Cell", "de"],
				["translation.widget_class", "Title", "de"]
			]);
			const indexed = localizationQualityWorkspaceOf(source, quality);
			const request = { target: fixture.target.name, filter: "character_budget" } as const;
			expect(indexed.export(request)).toEqual(legacy.export(request));
			expect(indexed.search(request)).toEqual(legacy.search(request));
		}).pipe(Effect.provide(fixture.layer()));
	}).pipe(Effect.scoped)
);
