import { describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SavedAssetPackageTextRecord } from "@ue-shed/unreal-assets";
import { textCorpusReportHeader } from "./corpus-summary.js";
import { GameTextIndexRefresh } from "./index-refresh.js";
import { makeIndexRegressionFixture } from "./index-refresh-regressions.test-support.js";
import { typeScriptIndexBuilderLayer } from "./index-reference.test-support.js";
import { nativeIndexBuilderLayer } from "./native-index-builder.js";
import {
	derivedAggregate,
	derivedCorpusFingerprint,
	derivedCorpusHeader,
	derivedLineViews,
	type DerivedReadsBase
} from "./index-derived-reads.test-support.js";
import {
	LocalizationLineField,
	TextAggregateRequest,
	type TextAggregateDimension
} from "./index-reads.js";
import type { GameTextIndexRefreshResult } from "./index-contract.js";
import {
	createLocalizationBaseline,
	indexedLocalizationBaseline,
	indexedLocalizationProgressReport,
	localizationProgressReport
} from "./localization-reports.js";
import {
	LOCALIZATION_GATE_FIELDS,
	DEFAULT_GATE_FAILURES,
	indexedLocalizationGateTarget,
	localizationGateTarget
} from "./localization-gate.js";
import { LOCALIZATION_LINES_CSV_FIELDS, localizationLinesCsv } from "./localization-export.js";
import { localizationWordCount } from "./localization-words.js";
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

/**
 * The derived oracle reads lines through the model's own whole-line exports: one pass records the
 * requests it makes, the exports answer them, and a second pass derives from those answers.
 */
const deriveFrom = <A>(model: GameTextIndexRefreshResult, derive: (base: DerivedReadsBase) => A) =>
	Effect.gen(function* () {
		const corpus = yield* model.query.readCorpus();
		const requests = new Map<string, Matching>();
		const answers = new Map<
			string,
			readonly import("./localization-schema.js").LocalizationLine[]
		>();
		const base = (record: boolean): DerivedReadsBase => ({
			lines: (request) => {
				const key = JSON.stringify(request);
				if (record) requests.set(key, request);
				return answers.get(key) ?? [];
			},
			search: () => {
				throw new Error("The derived reads do not search.");
			},
			corpus: () => corpus,
			cultures: model.localization.cultures
		});
		derive(base(true));
		for (const [key, request] of requests)
			answers.set(key, yield* model.query.localizationLines(request));
		return derive(base(false));
	});

const dimensionSets: readonly (readonly TextAggregateDimension[])[] = [
	["culture", "state"],
	["culture", "state", "fact"],
	["culture", "state", "unknown_reason"],
	["culture", "review_status"],
	["culture", "review"],
	["culture", "gathered", "review_flag"],
	["translation_key"],
	["source"],
	["gathered", "audience"],
	["problem"],
	["finding"],
	["origin"],
	["culture", "state", "problem"]
];
const filters: readonly (readonly TextFilterClause[])[] = [
	[],
	[{ field: "source", op: "is", values: ["Mushroom", "Stem"] }],
	[{ field: "problem", op: "is_not", values: ["up_to_date"] }],
	[{ field: "translation", op: "is", values: ["not_synced", "missing"] }]
];

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
						}).pipe(
							Effect.provide(fixture.layer(false, fixture.source, false, builder))
						);
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

							// Grouped counts equal counts derived from whole lines, every dimension.
							for (const by of dimensionSets)
								for (const filter of filters)
									for (const cultures of [
										undefined,
										[fixture.target.cultures[1]!]
									]) {
										const request = TextAggregateRequest.make({
											...lines,
											localization: {
												...localization,
												...(cultures ? { cultures } : undefined)
											},
											...(filter.length ? { filter } : undefined),
											by,
											measures: ["lines", "sourceWords", "lineBreakWords"]
										});
										const expected = yield* deriveFrom(model, (base) =>
											derivedAggregate(base, request)
										);
										expect(
											yield* model.query.aggregate(request),
											JSON.stringify({ by, filter, cultures })
										).toEqual(expected);
									}
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

							// Line fields equal the whole lines, filters and corpus they come from.
							const fields = LocalizationLineField.literals;
							for (const filter of filters) {
								const request = {
									...lines,
									...(filter.length ? { filter } : undefined)
								};
								expect(
									yield* model.query.selectLocalizationLines(request, fields)
								).toEqual(
									yield* deriveFrom(model, (base) =>
										derivedLineViews(base, request, fields)
									)
								);
							}

							// The header and fingerprint are the corpus's.
							const corpus = yield* model.query.readCorpus();
							expect(yield* model.query.readCorpusHeader()).toEqual(
								derivedCorpusHeader(corpus)
							);
							expect(yield* model.query.corpusFingerprint()).toBe(
								derivedCorpusFingerprint(corpus)
							);
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
							for (const files of [
								["Content/Text/Table.uasset"],
								["Content/Shop/Store.uasset", "Content/Missing.uasset"]
							]) {
								const scoped = { ...lines, where: { files } };
								const gate = yield* indexedLocalizationGateTarget(model.query, {
									join: model.localization,
									files,
									failOn: DEFAULT_GATE_FAILURES
								});
								const fileScope = (yield* model.query.search({
									...scoped,
									pageSize: 1
								})).fileScope;
								expect(gate).toEqual(
									localizationGateTarget({
										lines: yield* deriveFrom(model, (base) =>
											derivedLineViews(base, scoped, LOCALIZATION_GATE_FIELDS)
										),
										...(fileScope === undefined ? undefined : { fileScope }),
										join: model.localization,
										files,
										failOn: DEFAULT_GATE_FAILURES
									})
								);
							}

							// The all-languages CSV from projected lines equals the CSV from whole lines.
							const all = yield* model.query.localizationLines(lines);
							expect(
								localizationLinesCsv({
									join: model.localization,
									lines: yield* model.query.selectLocalizationLines(
										lines,
										LOCALIZATION_LINES_CSV_FIELDS
									)
								})
							).toEqual(
								localizationLinesCsv({
									join: model.localization,
									lines: all,
									corpus
								})
							);
							expect(model.revision).toEqual(expect.any(String));
						}).pipe(
							Effect.provide(fixture.layer(false, fixture.source, false, builder))
						);
					})
				)
			);
		}, 120_000);
});
