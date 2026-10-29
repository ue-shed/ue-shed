import { describe, expect, it } from "vitest";
import { referenceLocalizationLinesCsv } from "./localization-csv-reference.test-support.js";
import { Effect, Schema } from "effect";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { SavedAssetPackageTextRecord } from "@ue-shed/unreal-assets";
import { textCorpusReportHeader } from "./corpus-summary.js";
import { GameTextIndexRefresh } from "./index-refresh.js";
import { makeIndexRegressionFixture } from "./index-refresh-regressions.test-support.js";
import { typeScriptIndexBuilderLayer } from "./index-reference.test-support.js";
import { nativeIndexBuilderLayer } from "./native-index-builder.js";
import {
	LocalizationLineField,
	TextAggregateRequest,
	type LocalizationLineView,
	type TextAggregateDimension
} from "./index-reads.js";
import {
	createLocalizationBaseline,
	indexedLocalizationBaseline,
	indexedLocalizationProgressReport,
	localizationProgressReport
} from "./localization-reports.js";
import { DEFAULT_GATE_FAILURES, indexedLocalizationGateTarget } from "./localization-gate.js";
import {
	LOCALIZATION_LINES_CSV_FIELDS,
	pickedLocalizationCultures
} from "./localization-export.js";
import { localizationWordCount } from "./localization-words.js";
import { referenceCorpusCsv } from "./csv-reference.test-support.js";
import {
	corpusInvestigationEnvelope,
	exportGameTextInvestigation,
	type GameTextInvestigationPreset
} from "./investigation.js";
import { corpusWithoutUnits } from "./index-reads.js";
import { effectiveRuleDocument } from "./rules/effective.js";
import { hasSearchableSource } from "./search.js";
import { STARTER_CHECK_RULES } from "./starter-rules.js";
import type { TextCorpusSearchRequest, TextFilterClause } from "./schema.js";

type Occurrence = SavedAssetPackageTextRecord["occurrences"][number];
type Matching = Omit<TextCorpusSearchRequest, "cursor" | "pageSize">;

const executable = process.env.UE_SHED_UASSET_EXECUTABLE;

const text = (
	namespace: string,
	key: string,
	source: string,
	property: string,
	object = "/Game/Text/Table.Table"
): Occurrence => ({
	source,
	dev_notes: "",
	identity: { status: "resolved", namespace, key },
	location: {
		kind: "asset_property",
		object_path: object,
		class_path: "/Script/Engine.DataAsset",
		property_path: property
	},
	edit_capability: "read_only"
});

// Words that count differently by whitespace and by line breaks, a Thai text without a count,
// lone surrogates, a key with two texts, shared and duplicate texts, and keys the manifest lists
// with other text, optionally or not at all.
const saved: Occurrence[] = [
	text("UI", "Title", "Mushroom", "Title"),
	text("UI", "Header", "Mushroom", "Header"),
	text("Shop", "Item", "Mushroom", "Item"),
	text("UI", "Cap", "Red cap", "CapA"),
	text("UI", "Cap", "Blue cap", "CapB"),
	text("UI", "Hyphen", "well-known e-mail (ok)", "Hyphen"),
	text("UI", "Thai", "ภาษาไทย ok", "Thai"),
	text("UI", "Lone", "a\ud800 b", "Lone"),
	text("UI", "Changed", "New wording", "Changed"),
	text("UI", "Synced", "Press {Key} to jump!", "Synced"),
	text("UI", "Optional", "Only optional", "Optional"),
	text("Shop", "Stem", "Stem", "ShopStem", "/Game/Shop/Store.Store"),
	text("UI", "New", "Brand new text", "New", "/Game/Shop/Store.Store")
];
const manifest = {
	FormatVersion: 1,
	Namespace: "",
	Children: [],
	Subnamespaces: [
		{
			Namespace: "UI",
			Children: [
				{
					Source: { Text: "Mushroom" },
					Keys: [{ Key: "Title", Path: "/Game/Text/Table.Table.Title" }]
				},
				{
					Source: { Text: "Mushroom" },
					Keys: [{ Key: "Header", Path: "/Game/Text/Table.Table.Header" }]
				},
				{
					Source: { Text: "Red cap" },
					Keys: [{ Key: "Cap", Path: "/Game/Text/Table.Table.CapA" }]
				},
				{
					Source: { Text: "well-known e-mail (ok)" },
					Keys: [{ Key: "Hyphen", Path: "/Game/Text/Table.Table.Hyphen" }]
				},
				{
					Source: { Text: "Old wording here" },
					Keys: [{ Key: "Changed", Path: "/Game/Text/Table.Table.Changed" }]
				},
				{
					Source: { Text: "Press {Key} to jump!" },
					Keys: [{ Key: "Synced", Path: "/Game/Text/Table.Table.Synced" }]
				},
				{
					Source: { Text: "Only optional" },
					Keys: [
						{ Key: "Optional", Path: "/Game/Text/Table.Table.Optional", Optional: true }
					]
				},
				{
					Source: { Text: "Gone from saves" },
					Keys: [{ Key: "Gone", Path: "/Game/Text/Table.Table.Gone" }]
				}
			]
		},
		{
			Namespace: "Shop",
			Children: [
				{
					Source: { Text: "Mushroom" },
					Keys: [{ Key: "Item", Path: "/Game/Text/Table.Table.Item" }]
				},
				{
					Source: { Text: "Stem" },
					Keys: [{ Key: "Stem", Path: "/Game/Shop/Store.Store.ShopStem" }]
				}
			]
		}
	]
};
const archive = (culture: string) => ({
	FormatVersion: 2,
	Namespace: "",
	Children: [],
	Subnamespaces: [
		{
			Namespace: "UI",
			Children: [
				["Title", "Mushroom"],
				["Cap", "Red cap"],
				["Hyphen", "well-known e-mail (ok)"],
				["Changed", "Old wording here"],
				["Synced", "Press {Key} to jump!"],
				["Gone", "Gone from saves"]
			].map(([Key, Text]) => ({
				Key,
				Source: { Text },
				Translation: { Text: `${culture}: ${Text}` }
			}))
		},
		{
			Namespace: "Shop",
			Children: [
				{ Key: "Stem", Source: { Text: "Stem" }, Translation: { Text: `${culture} Stiel` } }
			]
		}
	]
});
// A PO edit not yet synced to the archive.
const po = (culture: string) =>
	`msgctxt "UI,Synced"\nmsgid "Press {Key} to jump!"\nmsgstr "${culture} pending"\n`;

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

const mushroomOrStem: readonly TextFilterClause[] = [
	{ field: "source", op: "is", values: ["Mushroom", "Stem"] }
];
const withProblems: readonly TextFilterClause[] = [
	{ field: "problem", op: "is_not", values: ["up_to_date"] }
];
const notTranslated: readonly TextFilterClause[] = [
	{ field: "translation", op: "is", values: ["not_synced", "missing"] }
];
const key = (namespace: string, name: string) => JSON.stringify([namespace, name]);

/**
 * Each aggregate's groups as [key, lines, source words, line-break words, lines without a word
 * count]. Every language's archive holds `<culture>: <source>` for Title, Cap, Hyphen, Changed,
 * Synced and Gone: the native culture's translation differs from its source, so English counts
 * them translated and German's archive, written for the earlier English, needs an update. Lone,
 * Thai and New are not in the manifest; Gone is only there, and Stem's manifest entry names a
 * package the project lacks. Source words split on whitespace; line-break words are Unreal's, of
 * the gathered text: Changed counts "Old wording here", Cap "Red cap", and Thai text has none.
 */
const aggregates: readonly {
	readonly by: readonly TextAggregateDimension[];
	readonly filter?: readonly TextFilterClause[];
	readonly cultures?: readonly string[];
	readonly lines: number;
	readonly groups: readonly (readonly [readonly string[], number, number, number, number])[];
}[] = [
	{
		by: ["culture", "state"],
		lines: 13,
		groups: [
			[["en", "translated"], 2, 4, 6, 0],
			[["en", "not_translated"], 3, 4, 4, 0],
			[["en", "not_synced"], 1, 4, 4, 0],
			[["en", "not_gathered"], 3, 7, 5, 1],
			[["en", "changed_since_gather"], 1, 2, 3, 0],
			[["en", "not_found"], 2, 4, 4, 0],
			[["en", "unknown"], 1, 4, 2, 0],
			[["de", "not_translated"], 3, 4, 4, 0],
			[["de", "needs_update"], 2, 4, 6, 0],
			[["de", "not_synced"], 1, 4, 4, 0],
			[["de", "not_gathered"], 3, 7, 5, 1],
			[["de", "changed_since_gather"], 1, 2, 3, 0],
			[["de", "not_found"], 2, 4, 4, 0],
			[["de", "unknown"], 1, 4, 2, 0]
		]
	},
	{
		by: ["culture", "state"],
		cultures: ["de"],
		lines: 13,
		groups: [
			[["de", "not_translated"], 3, 4, 4, 0],
			[["de", "needs_update"], 2, 4, 6, 0],
			[["de", "not_synced"], 1, 4, 4, 0],
			[["de", "not_gathered"], 3, 7, 5, 1],
			[["de", "changed_since_gather"], 1, 2, 3, 0],
			[["de", "not_found"], 2, 4, 4, 0],
			[["de", "unknown"], 1, 4, 2, 0]
		]
	},
	{
		by: ["culture", "state"],
		filter: mushroomOrStem,
		lines: 4,
		groups: [
			[["en", "translated"], 1, 1, 1, 0],
			[["en", "not_translated"], 2, 2, 2, 0],
			[["en", "not_found"], 1, 1, 1, 0],
			[["de", "not_translated"], 2, 2, 2, 0],
			[["de", "needs_update"], 1, 1, 1, 0],
			[["de", "not_found"], 1, 1, 1, 0]
		]
	},
	{
		by: ["culture", "state"],
		filter: mushroomOrStem,
		cultures: ["de"],
		lines: 4,
		groups: [
			[["de", "not_translated"], 2, 2, 2, 0],
			[["de", "needs_update"], 1, 1, 1, 0],
			[["de", "not_found"], 1, 1, 1, 0]
		]
	},
	{
		by: ["culture", "state"],
		filter: withProblems,
		lines: 13,
		groups: [
			[["en", "translated"], 2, 4, 6, 0],
			[["en", "not_translated"], 3, 4, 4, 0],
			[["en", "not_synced"], 1, 4, 4, 0],
			[["en", "not_gathered"], 3, 7, 5, 1],
			[["en", "changed_since_gather"], 1, 2, 3, 0],
			[["en", "not_found"], 2, 4, 4, 0],
			[["en", "unknown"], 1, 4, 2, 0],
			[["de", "not_translated"], 3, 4, 4, 0],
			[["de", "needs_update"], 2, 4, 6, 0],
			[["de", "not_synced"], 1, 4, 4, 0],
			[["de", "not_gathered"], 3, 7, 5, 1],
			[["de", "changed_since_gather"], 1, 2, 3, 0],
			[["de", "not_found"], 2, 4, 4, 0],
			[["de", "unknown"], 1, 4, 2, 0]
		]
	},
	{
		by: ["culture", "state"],
		filter: notTranslated,
		lines: 4,
		groups: [
			[["en", "not_translated"], 3, 4, 4, 0],
			[["en", "not_synced"], 1, 4, 4, 0],
			[["de", "not_translated"], 3, 4, 4, 0],
			[["de", "not_synced"], 1, 4, 4, 0]
		]
	},
	{
		by: ["culture", "state", "fact"],
		lines: 13,
		groups: [
			[["en", "translated", "translated"], 2, 4, 6, 0],
			[["en", "not_translated", "not_translated"], 3, 4, 4, 0],
			[["en", "not_synced", "translated"], 1, 4, 4, 0],
			[["en", "not_synced", "not_synced"], 1, 4, 4, 0],
			[["en", "not_gathered", "not_translated"], 3, 7, 5, 1],
			[["en", "not_gathered", "not_gathered"], 3, 7, 5, 1],
			[["en", "changed_since_gather", "translated"], 1, 2, 3, 0],
			[["en", "changed_since_gather", "changed_since_gather"], 1, 2, 3, 0],
			[["en", "not_found", "translated"], 2, 4, 4, 0],
			[["en", "not_found", "not_found"], 2, 4, 4, 0],
			[["en", "unknown", "translated"], 1, 4, 2, 0],
			[["en", "unknown", "unknown"], 1, 4, 2, 0],
			[["de", "not_translated", "not_translated"], 3, 4, 4, 0],
			[["de", "needs_update", "needs_update"], 2, 4, 6, 0],
			[["de", "not_synced", "needs_update"], 1, 4, 4, 0],
			[["de", "not_synced", "not_synced"], 1, 4, 4, 0],
			[["de", "not_gathered", "not_translated"], 3, 7, 5, 1],
			[["de", "not_gathered", "not_gathered"], 3, 7, 5, 1],
			[["de", "changed_since_gather", "needs_update"], 1, 2, 3, 0],
			[["de", "changed_since_gather", "changed_since_gather"], 1, 2, 3, 0],
			[["de", "not_found", "needs_update"], 2, 4, 4, 0],
			[["de", "not_found", "not_found"], 2, 4, 4, 0],
			[["de", "unknown", "needs_update"], 1, 4, 2, 0],
			[["de", "unknown", "unknown"], 1, 4, 2, 0]
		]
	},
	{
		by: ["culture", "state", "unknown_reason"],
		lines: 13,
		groups: [
			[["en", "unknown", "conflicting_source"], 1, 4, 2, 0],
			[["de", "unknown", "conflicting_source"], 1, 4, 2, 0]
		]
	},
	{ by: ["culture", "review_status"], lines: 13, groups: [] },
	{ by: ["culture", "review"], lines: 13, groups: [] },
	{ by: ["culture", "gathered", "review_flag"], lines: 13, groups: [] },
	{
		by: ["translation_key"],
		lines: 13,
		groups: [
			[[key("Shop", "Item")], 1, 1, 1, 0],
			[[key("Shop", "Stem")], 1, 1, 1, 0],
			[[key("UI", "Cap")], 1, 4, 2, 0],
			[[key("UI", "Changed")], 1, 2, 3, 0],
			[[key("UI", "Gone")], 1, 3, 3, 0],
			[[key("UI", "Header")], 1, 1, 1, 0],
			[[key("UI", "Hyphen")], 1, 3, 5, 0],
			[[key("UI", "Lone")], 1, 2, 2, 0],
			[[key("UI", "New")], 1, 3, 3, 0],
			[[key("UI", "Optional")], 1, 2, 2, 0],
			[[key("UI", "Synced")], 1, 4, 4, 0],
			[[key("UI", "Thai")], 1, 2, 0, 1],
			[[key("UI", "Title")], 1, 1, 1, 0]
		]
	},
	{
		by: ["source"],
		lines: 13,
		groups: [
			[["Brand new text"], 1, 3, 3, 0],
			[["Gone from saves"], 1, 3, 3, 0],
			[["Mushroom"], 3, 3, 3, 0],
			[["New wording"], 1, 2, 3, 0],
			[["Only optional"], 1, 2, 2, 0],
			[["Press {Key} to jump!"], 1, 4, 4, 0],
			[["Red cap Blue cap"], 1, 4, 2, 0],
			[["Stem"], 1, 1, 1, 0],
			[["a\ud800 b"], 1, 2, 2, 0],
			[["well-known e-mail (ok)"], 1, 3, 5, 0],
			[["ภาษาไทย ok"], 1, 2, 0, 1]
		]
	},
	{
		by: ["gathered", "audience"],
		lines: 13,
		groups: [
			[["false", "unknown"], 3, 7, 5, 1],
			[["true", "unknown"], 10, 22, 23, 0]
		]
	},
	{
		by: ["problem"],
		lines: 13,
		groups: [
			[["conflicting_source"], 1, 4, 2, 0],
			[["not_gathered"], 3, 7, 5, 1],
			[["changed_since_gather"], 3, 6, 7, 0],
			[["translation"], 6, 12, 14, 0],
			[["unchecked"], 1, 4, 2, 0]
		]
	},
	{
		by: ["problem"],
		filter: mushroomOrStem,
		lines: 4,
		groups: [
			[["changed_since_gather"], 1, 1, 1, 0],
			[["translation"], 3, 3, 3, 0]
		]
	},
	{ by: ["problem"], filter: notTranslated, lines: 4, groups: [[["translation"], 4, 8, 8, 0]] },
	{ by: ["finding"], lines: 13, groups: [] },
	{ by: ["origin"], lines: 13, groups: [[["asset"], 13, 29, 28, 1]] },
	{
		by: ["culture", "state", "problem"],
		lines: 13,
		groups: [
			[["en", "translated", "translation"], 2, 4, 6, 0],
			[["en", "not_translated", "translation"], 3, 4, 4, 0],
			[["en", "not_synced", "translation"], 1, 4, 4, 0],
			[["en", "not_gathered", "not_gathered"], 3, 7, 5, 1],
			[["en", "changed_since_gather", "changed_since_gather"], 1, 2, 3, 0],
			[["en", "not_found", "changed_since_gather"], 2, 4, 4, 0],
			[["en", "unknown", "conflicting_source"], 1, 4, 2, 0],
			[["en", "unknown", "unchecked"], 1, 4, 2, 0],
			[["de", "not_translated", "translation"], 3, 4, 4, 0],
			[["de", "needs_update", "translation"], 2, 4, 6, 0],
			[["de", "not_synced", "translation"], 1, 4, 4, 0],
			[["de", "not_gathered", "not_gathered"], 3, 7, 5, 1],
			[["de", "changed_since_gather", "changed_since_gather"], 1, 2, 3, 0],
			[["de", "not_found", "changed_since_gather"], 2, 4, 4, 0],
			[["de", "unknown", "conflicting_source"], 1, 4, 2, 0],
			[["de", "unknown", "unchecked"], 1, 4, 2, 0]
		]
	}
];

const table = {
	packageFile: "Content/Text/Table.uasset",
	objectPath: "/Game/Text/Table.Table",
	origin: "asset"
};
const store = { ...table, objectPath: "/Game/Shop/Store.Store" };
const notTranslatedMarks = [
	["en", "not_translated", ["not_translated"], null],
	["de", "not_translated", ["not_translated"], null]
];
const notGatheredMarks = [
	["en", "not_gathered", ["not_translated", "not_gathered"], null],
	["de", "not_gathered", ["not_translated", "not_gathered"], null]
];
const evidenceOnly = ["evidence_only"];
/** Every line's facts, each culture's mark as [culture, state, facts, shipped translation]. */
const lineFacts = [
	{
		key: "Shop/Item",
		source: "Mushroom",
		problems: ["translation"],
		signals: evidenceOnly,
		places: [table],
		marks: notTranslatedMarks
	},
	{
		key: "Shop/Stem",
		source: "Stem",
		problems: ["changed_since_gather"],
		signals: evidenceOnly,
		places: [store],
		marks: [
			["en", "not_found", ["translated", "not_found"], "en Stiel"],
			["de", "not_found", ["needs_update", "not_found"], "de Stiel"]
		]
	},
	{
		key: "UI/Cap",
		source: "Red cap Blue cap",
		problems: ["conflicting_source", "unchecked"],
		signals: ["conflicting", "evidence_only"],
		places: [table, table],
		marks: [
			["en", "unknown", ["translated", "unknown"], "en: Red cap"],
			["de", "unknown", ["needs_update", "unknown"], "de: Red cap"]
		]
	},
	{
		key: "UI/Changed",
		source: "New wording",
		problems: ["changed_since_gather"],
		signals: evidenceOnly,
		places: [table],
		marks: [
			[
				"en",
				"changed_since_gather",
				["translated", "changed_since_gather"],
				"en: Old wording here"
			],
			[
				"de",
				"changed_since_gather",
				["needs_update", "changed_since_gather"],
				"de: Old wording here"
			]
		]
	},
	{
		key: "UI/Gone",
		source: "Gone from saves",
		problems: ["changed_since_gather"],
		signals: [],
		places: [],
		marks: [
			["en", "not_found", ["translated", "not_found"], "en: Gone from saves"],
			["de", "not_found", ["needs_update", "not_found"], "de: Gone from saves"]
		]
	},
	{
		key: "UI/Header",
		source: "Mushroom",
		problems: ["translation"],
		signals: evidenceOnly,
		places: [table],
		marks: notTranslatedMarks
	},
	{
		key: "UI/Hyphen",
		source: "well-known e-mail (ok)",
		problems: ["translation"],
		signals: evidenceOnly,
		places: [table],
		marks: [
			["en", "translated", ["translated"], "en: well-known e-mail (ok)"],
			["de", "needs_update", ["needs_update"], "de: well-known e-mail (ok)"]
		]
	},
	{
		key: "UI/Lone",
		source: "a\ud800 b",
		problems: ["not_gathered"],
		signals: evidenceOnly,
		places: [table],
		marks: notGatheredMarks
	},
	{
		key: "UI/New",
		source: "Brand new text",
		problems: ["not_gathered"],
		signals: evidenceOnly,
		places: [store],
		marks: notGatheredMarks
	},
	{
		key: "UI/Optional",
		source: "Only optional",
		problems: ["translation"],
		signals: evidenceOnly,
		places: [table],
		marks: notTranslatedMarks
	},
	{
		// The PO edit not yet synced to the archive is the translation it ships.
		key: "UI/Synced",
		source: "Press {Key} to jump!",
		problems: ["translation"],
		signals: evidenceOnly,
		places: [table],
		marks: [
			["en", "not_synced", ["translated", "not_synced"], "en pending"],
			["de", "not_synced", ["needs_update", "not_synced"], "de pending"]
		]
	},
	{
		key: "UI/Thai",
		source: "ภาษาไทย ok",
		problems: ["not_gathered"],
		signals: evidenceOnly,
		places: [table],
		marks: notGatheredMarks
	},
	{
		key: "UI/Title",
		source: "Mushroom",
		problems: ["translation"],
		signals: evidenceOnly,
		places: [table],
		marks: [
			["en", "translated", ["translated"], "en: Mushroom"],
			["de", "needs_update", ["needs_update"], "de: Mushroom"]
		]
	}
];
const allLines = lineFacts.map((line) => line.key);
/** The lines each filter selects. */
const filteredLines: readonly (readonly [readonly TextFilterClause[], readonly string[]])[] = [
	[[], allLines],
	[mushroomOrStem, ["Shop/Item", "Shop/Stem", "UI/Header", "UI/Title"]],
	[withProblems, allLines],
	[notTranslated, ["Shop/Item", "UI/Header", "UI/Optional", "UI/Synced"]]
];
/** A line view's facts, in the shape `lineFacts` plants. */
const factsOf = (view: LocalizationLineView<LocalizationLineField>) => ({
	key: `${view.identity?.namespace}/${view.identity?.key}`,
	source: view.source,
	problems: view.problems,
	signals: view.signals,
	// The fixture's package paths use the platform's separator.
	places: view.places?.map((place) => ({
		...place,
		packageFile: place.packageFile.replaceAll("\\", "/")
	})),
	marks: view.marks?.map((mark) => [mark.culture, mark.state, mark.facts, mark.translation])
});

describe("index reads", () => {
	it("validates aggregate requests", () => {
		const valid = Schema.is(TextAggregateRequest);
		const base = { query: "", capability: "all" } as const;
		const localization = { target: "Game" };
		expect(valid({ ...base, localization, by: ["culture", "state"] })).toBe(true);
		expect(valid({ ...base, by: ["source", "problem"], measures: ["lineBreakWords"] })).toBe(
			true
		);
		expect(valid({ ...base, localization, by: ["state"] })).toBe(false);
		expect(valid({ ...base, localization, by: ["state", "culture"] })).toBe(false);
		expect(valid({ ...base, by: ["culture"] })).toBe(false);
		expect(valid({ ...base, by: ["translation_key"] })).toBe(false);
		expect(valid({ ...base, localization, by: [] })).toBe(false);
		expect(valid({ ...base, localization, by: ["source", "source"] })).toBe(false);
		expect(Schema.is(LocalizationLineField)("places")).toBe(true);
		expect(Schema.is(LocalizationLineField)("occurrences")).toBe(false);
	});

	for (const [name, builder] of builders)
		it(`preserves exact UTF-16 filters and report diagnostics through the ${name}`, async () => {
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const fixture = yield* makeIndexRegressionFixture();
						const sources = [
							"a\ud800 b",
							"a\udc00 b",
							"a\u{f0000}\u{f0001}\u{f0800} b"
						];
						fixture.update(
							sources.map((source, i) => text("UI", `Utf${i}`, source, `Label${i}`))
						);
						fixture.patchRecord({
							status: "partial",
							gapSamples: sources.map((source) => ({
								object_path: "/Game/Text/Table.Table",
								property_path: `Label${source}`,
								reason: "property_decoder_rejected"
							})),
							gapCounts: {
								unsupported_text_history: 0,
								legacy_container_element_without_type_information: 0,
								feature_unavailable_for_engine_version: 0,
								property_decoder_rejected: sources.length
							}
						});
						yield* Effect.gen(function* () {
							const model = yield* (yield* GameTextIndexRefresh).refresh(
								fixture.request
							);
							for (const source of sources) {
								const matching: Matching = {
									query: "",
									capability: "all",
									localization: { target: fixture.target.name },
									filter: [{ field: "source", op: "is", values: [source] }]
								};
								expect(
									(yield* model.query.search({ ...matching, pageSize: 50 })).total
								).toBe(1);
								expect(
									(yield* model.query.aggregate({ ...matching, by: ["source"] }))
										.lines
								).toBe(1);
								expect(
									(yield* model.query.selectLocalizationLines(matching, [
										"source"
									])).map((line) => line.source)
								).toEqual([source]);
								expect(
									(yield* model.query.localizationLines(matching)).map(
										(line) => line.source
									)
								).toEqual([source]);
								expect(
									(yield* model.query.export(matching)).units.map(
										(unit) => unit.source
									)
								).toEqual([{ status: "consistent", value: source }]);
							}
							const header = yield* model.query.readCorpusHeader();
							expect(header.diagnostics.length).toBeGreaterThan(0);
							expect(yield* model.query.readCorpusReportHeader()).toEqual(
								textCorpusReportHeader(header)
							);
						}).pipe(Effect.provide(fixture.layer(fixture.source, builder)));
					})
				)
			);
		});

	for (const [name, builder] of builders)
		it(`answers aggregates, line fields, the header and fingerprint, and the reports built on them through the ${name}`, async () => {
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const fixture = yield* makeIndexRegressionFixture();
						yield* Effect.promise(async () => {
							await writeFile(
								join(fixture.projectRoot, "Review.manifest"),
								JSON.stringify(manifest)
							);
							for (const culture of fixture.target.cultures) {
								await writeFile(
									join(fixture.projectRoot, `${culture}.archive`),
									JSON.stringify(archive(culture))
								);
								await writeFile(
									join(fixture.projectRoot, `${culture}.po`),
									po(culture)
								);
							}
						});
						fixture.update(saved);
						yield* Effect.gen(function* () {
							const model = yield* (yield* GameTextIndexRefresh).refresh(
								fixture.request
							);
							const localization = { target: fixture.target.name };
							const lines = { query: "", capability: "all" as const, localization };

							// Grouped counts and words, every dimension, under filters and picked cultures.
							for (const { by, filter, cultures, ...expected } of aggregates)
								expect(
									yield* model.query.aggregate(
										TextAggregateRequest.make({
											...lines,
											localization: {
												...localization,
												...(cultures
													? {
															cultures:
																fixture.target.cultures.filter(
																	(code) =>
																		cultures.includes(code)
																)
														}
													: undefined)
											},
											...(filter ? { filter } : undefined),
											by,
											measures: ["lines", "sourceWords", "lineBreakWords"]
										})
									),
									JSON.stringify({ by, filter, cultures })
								).toEqual({
									lines: expected.lines,
									groups: expected.groups.map(
										([
											key,
											count,
											sourceWords,
											lineBreakWords,
											unknownWords
										]) => ({
											key,
											lines: count,
											sourceWords,
											lineBreakWords,
											unknownWords
										})
									)
								});
							// The words a line counts are Unreal's: Thai text has none.
							const words = yield* model.query.aggregate({
								...lines,
								by: ["source"],
								measures: ["lineBreakWords"]
							});
							const hyphen = words.groups.find(
								(group) => group.key[0] === "well-known e-mail (ok)"
							);
							expect(localizationWordCount("well-known e-mail (ok)")).toEqual({
								status: "counted",
								words: hyphen?.lineBreakWords
							});
							expect(
								words.groups.find((group) => group.key[0] === "ภาษาไทย ok")
									?.unknownWords
							).toBe(1);

							// Line fields hold each selected line's facts, and only the fields asked for.
							const fields = LocalizationLineField.literals;
							for (const [filter, keys] of filteredLines) {
								const views = yield* model.query.selectLocalizationLines(
									{ ...lines, ...(filter.length ? { filter } : undefined) },
									fields
								);
								expect(views.map(factsOf), JSON.stringify(filter)).toEqual(
									lineFacts.filter((line) => keys.includes(line.key))
								);
								// No line here has a key change or lies out of scope.
								for (const view of views)
									expect(Object.keys(view).sort()).toEqual(
										["id", ...fields]
											.filter(
												(field) =>
													field !== "keyChange" && field !== "outOfScope"
											)
											.sort()
									);
							}
							const conflicting = yield* model.query.selectLocalizationLines(
								{
									...lines,
									filter: [{ field: "fact", op: "is", values: ["conflicting"] }]
								},
								["identity", "marks"]
							);
							expect(
								conflicting.map((view) => [
									Object.keys(view).sort(),
									view.identity?.key,
									view.marks.map((mark) => mark.unknownReasons)
								])
							).toEqual([
								[
									["id", "identity", "marks"],
									"Cap",
									[["conflicting_source"], ["conflicting_source"]]
								]
							]);

							// The header is the corpus's without its units.
							const corpus = yield* model.query.readCorpus();
							const { units: _units, ...header } = corpus;
							expect(yield* model.query.readCorpusHeader()).toEqual(header);
							const unitIds = corpus.units.slice(0, 3).map((unit) => unit.id);
							expect(yield* model.query.readUnits([...unitIds, unitIds[0]!])).toEqual(
								corpus.units.slice(0, 3)
							);

							// Reports built on them equal the reports built on the whole corpus and join.
							const join = yield* model.localizationJoin;
							const createdAt = "2026-10-20T00:00:00Z";
							const baseline = createLocalizationBaseline(
								corpus,
								model.evidence,
								createdAt
							);
							// The engine fingerprints the corpus as the baseline does.
							expect(yield* model.query.corpusFingerprint()).toBe(
								baseline.provenance.corpusGeneration
							);
							expect(yield* indexedLocalizationBaseline(model, createdAt)).toEqual(
								baseline
							);
							expect(yield* indexedLocalizationProgressReport(model)).toEqual(
								localizationProgressReport(corpus, join, model.evidence)
							);
							const previous = { ...baseline, entries: baseline.entries.slice(1) };
							expect(
								yield* indexedLocalizationProgressReport(model, previous)
							).toEqual(
								localizationProgressReport(corpus, join, model.evidence, previous)
							);
							const report = yield* indexedLocalizationProgressReport(model);
							expect(report.cultures[0]?.notSynced.lines).toBe(1);
							expect(report.cultures[0]?.states.not_gathered.sourceWords).toBeNull();

							// The gate reads one projected line export; the old one read five and the corpus.
							// The table's lines fail on Cap's two texts and Changed's stale translations, and
							// warn that Gone left the table and three lines were never gathered.
							const changed = yield* indexedLocalizationGateTarget(model.query, {
								join: model.localization,
								files: ["Content/Text/Table.uasset"],
								failOn: DEFAULT_GATE_FAILURES
							});
							const { items, fileScope, ...decided } = changed;
							expect(decided).toEqual({
								target: fixture.target.name,
								status: "failed",
								lines: 13,
								checks: {
									key_changed: 0,
									conflicting_source: 1,
									translated_text_changed: 1,
									text_changed: 0,
									not_gathered: 3,
									unresolved_key: 0,
									removed: 1,
									gathered_source: 0,
									partial_read: 0
								},
								omitted: 0
							});
							expect(items.map((item) => [item.check, item.key])).toEqual([
								["conflicting_source", "Cap"],
								["translated_text_changed", "Changed"],
								["not_gathered", "Lone"],
								["not_gathered", "New"],
								["not_gathered", "Thai"],
								["removed", "Gone"]
							]);
							expect(fileScope).toMatchObject({ files: 1, textFiles: 1, outside: 0 });
							// Files the project has no saved text in pass.
							const elsewhere = yield* indexedLocalizationGateTarget(model.query, {
								join: model.localization,
								files: ["Content/Shop/Store.uasset", "Content/Missing.uasset"],
								failOn: DEFAULT_GATE_FAILURES
							});
							expect([elsewhere.status, elsewhere.lines, elsewhere.items]).toEqual([
								"passed",
								0,
								[]
							]);
							expect(
								Object.values(elsewhere.checks).every((count) => count === 0)
							).toBe(true);
							expect(elsewhere.fileScope).toMatchObject({
								files: 2,
								textFiles: 0,
								outside: 0
							});

							// The all-languages CSV from projected lines equals the CSV from whole lines.
							const all = yield* model.query.localizationLines(lines);
							expect(
								referenceLocalizationLinesCsv({
									join: model.localization,
									lines: yield* model.query.selectLocalizationLines(
										lines,
										LOCALIZATION_LINES_CSV_FIELDS
									)
								})
							).toEqual(
								referenceLocalizationLinesCsv({
									join: model.localization,
									lines: all,
									corpus
								})
							);
							// The engine's sink writes the bytes the host writer did, for every culture and
							// for picked ones, and an exclusive sink leaves an existing file alone.
							if (name === "native engine") {
								const directory = yield* Effect.promise(() =>
									mkdtemp(resolve(tmpdir(), "culture-lines-"))
								);
								const picked = {
									...lines,
									localization: {
										...localization,
										cultures: [fixture.target.cultures.at(-1)!]
									}
								};
								for (const [index, request] of [lines, picked].entries()) {
									const path = resolve(directory, `${index}.csv`);
									const expected = referenceLocalizationLinesCsv({
										join: model.localization,
										lines: yield* model.query.localizationLines(request),
										corpus,
										cultures: pickedLocalizationCultures(request.localization)
									});
									const bytes = new TextEncoder().encode(expected.csv);
									expect(
										yield* model.query.writeLocalizationLinesCsv(request, {
											path
										})
									).toEqual({
										status: "written",
										rows: expected.rows,
										bytes: bytes.byteLength
									});
									expect(
										new Uint8Array(yield* Effect.promise(() => readFile(path)))
									).toEqual(bytes);
									expect(
										yield* model.query.writeLocalizationLinesCsv(request, {
											path,
											exclusive: true
										})
									).toEqual({ status: "exists" });
								}
								// Browse's CSV, likewise: the host wrote it from the engine's export, with
								// the rules' findings as its Findings column.
								const { key } = yield* model.query.findingsEvaluate(
									effectiveRuleDocument(STARTER_CHECK_RULES)
								);
								const corpusRequests = [
									{ query: "", capability: "all" },
									{ query: "", capability: "all", findings: { key } },
									{ ...lines, findings: { key } }
								] as const;
								for (const [index, request] of corpusRequests.entries()) {
									const exported = yield* model.query.exportWithSignals(request);
									const bytes = new TextEncoder().encode(
										referenceCorpusCsv(
											exported.corpus,
											exported.reviewSignals,
											exported.findings
										)
									);
									const path = resolve(directory, `corpus-${index}.csv`);
									expect(
										yield* model.query.writeCorpusCsv(request, { path })
									).toEqual({
										status: "written",
										rows: exported.corpus.units
											.filter(hasSearchableSource)
											.reduce(
												(rows, unit) => rows + unit.occurrences.length,
												0
											),
										bytes: bytes.byteLength
									});
									expect(
										new Uint8Array(yield* Effect.promise(() => readFile(path)))
									).toEqual(bytes);
								}
								// A corpus investigation's JSON: the engine writes the units into the document the
								// host made without them, the bytes the host wrote from the whole export.
								const source = {
									projectRoot: "/project",
									generation: 1,
									authority: "project_files"
								} as const;
								const rules = {
									sourceQuality: () =>
										Effect.die(
											new Error("A corpus export reads no source rules.")
										)
								};
								for (const [index, request] of [
									{ query: "", capability: "all" as const },
									lines
								].entries()) {
									const preset: GameTextInvestigationPreset = {
										schemaVersion: 1,
										kind: "game_text",
										sort: "domain_order",
										query: { ...request, mode: "corpus", qualityFilter: "all" }
									};
									const whole = yield* exportGameTextInvestigation(
										rules,
										preset,
										source,
										model.query
									);
									const bytes = new TextEncoder().encode(
										`${JSON.stringify(whole, null, "\t")}\n`
									);
									const envelope = corpusInvestigationEnvelope(
										yield* exportGameTextInvestigation(rules, preset, source, {
											export: () =>
												Effect.map(
													model.query.readCorpusHeader(),
													corpusWithoutUnits
												).pipe(Effect.orDie)
										})
									);
									const path = resolve(directory, `investigation-${index}.json`);
									expect(
										yield* model.query.writeCorpusJson(
											request,
											{ path },
											envelope
										)
									).toEqual({
										status: "written",
										rows:
											whole.result.mode === "corpus"
												? whole.result.corpus.units.length
												: -1,
										bytes: bytes.byteLength
									});
									expect(
										new TextDecoder().decode(
											yield* Effect.promise(() => readFile(path))
										)
									).toBe(new TextDecoder().decode(bytes));
								}
							}
							expect(model.revision).toEqual(expect.any(String));
						}).pipe(Effect.provide(fixture.layer(fixture.source, builder)));
					})
				)
			);
		}, 120_000);
});
