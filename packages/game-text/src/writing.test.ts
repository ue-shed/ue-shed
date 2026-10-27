import { indexedTestReports } from "./indexed-reports.test-support.js";
import { corpusCsvForTest } from "./export-reference.test-support.js";
import { Effect, Schema } from "effect";
import { it } from "@effect/vitest";
import { describe, expect } from "vitest";
import { referenceCorpusCsv as formatCsv } from "./csv-reference.test-support.js";
import { gameTextQualityCsv } from "./csv.js";
import { withIndexedCorpus } from "./indexed-corpus.test-support.js";
import { GameTextRuleDocument, decodeGameTextRuleDocument } from "./game-text-rules.js";
import { STARTER_GAME_TEXT_RULES } from "./starter-rules.js";
import {
	type TextCorpus,
	MAX_TEXT_QUERY_PAGE_SIZE,
	TextCorpusSearchPage,
	makeTextOccurrenceId,
	makeTextUnitId
} from "./schema.js";
function corpusOf(sources: readonly string[]): TextCorpus {
	return {
		schemaVersion: 1,
		status: "complete",
		diagnostics: [],
		coverage: {
			discoveredPackages: 1,
			inspectedPackages: 1,
			partialPackages: 0,
			failedPackages: 0,
			textUnits: sources.length,
			textOccurrences: sources.length * 2,
			resolvedOccurrences: sources.length * 2,
			unresolvedOccurrences: 0,
			unsupportedTextProperties: 0
		},
		units: sources.map((source, index) => ({
			id: makeTextUnitId(`line:${index}`),
			identity: { status: "resolved", namespace: "", key: `key:${index}` },
			source: { status: "consistent", value: source },
			occurrences: [0, 1].map((location) => ({
				id: makeTextOccurrenceId(`location:${index}:${location}`),
				identity: { status: "resolved", namespace: "", key: `key:${index}` },
				source,
				devNotes: index === 1 && location === 1 ? "A note" : " \t ",
				packageFile: "Content/Text/DT_Examples.uasset",
				editCapability: index === 1 ? "read_only" : "source_editable",
				location: {
					kind: "data_table_cell",
					objectPath: "/Game/Text/DT_Examples.DT_Examples",
					row: String(location),
					propertyPath: "DisplayName"
				}
			}))
		}))
	};
}
describe("writer counts", () => {
	it.live(
		"uses searchable lines for search, summary and role coverage without changing scan provenance",
		() => {
			const corpus = corpusOf(["row one", "row two", "", " \n "]);
			return withIndexedCorpus(corpus, {}, ({ query }) =>
				Effect.gen(function* () {
					const page = yield* query.search({
						query: "",
						capability: "all",
						pageSize: 50
					});
					expect(Schema.decodeUnknownSync(TextCorpusSearchPage)(page)).toEqual(page);
					expect(() =>
						Schema.decodeUnknownSync(TextCorpusSearchPage)({
							...page,
							counts: { ...page.counts, all: -1 }
						})
					).toThrow();
					expect(() =>
						Schema.decodeUnknownSync(TextCorpusSearchPage)({
							...page,
							units: Array.from(
								{ length: MAX_TEXT_QUERY_PAGE_SIZE + 1 },
								() => page.units[0]
							)
						})
					).toThrow();
					expect(
						(yield* query.search({ query: "", capability: "all", pageSize: 1 })).counts
					).toEqual(page.counts);
					expect(page.total).toBe(2);
					expect(page.counts.all).toBe(page.total);
					const summary = yield* query.summary();
					expect(summary.counts).toEqual(page.counts);
					expect(summary.review).toEqual({ all: 2, unresolved: 0, conflicting: 0 });
					expect(summary.sources.dataTable).toBe(2);
					expect(summary.searchable).toEqual({ textUnits: 2, textOccurrences: 4 });
					expect(summary.coverage).toEqual(corpus.coverage);
					const report = indexedTestReports(corpus).source(STARTER_GAME_TEXT_RULES);
					expect(report.roles.every((role) => role.matchedTextUnits === 2)).toBe(true);
					expect(report.roles.every((role) => role.matchedOccurrences === 4)).toBe(true);
				})
			);
		}
	);
	it.live(
		"counts the current query and filters, and requires every location to have blank notes",
		() =>
			withIndexedCorpus(corpusOf(["row one", "row two", "other", ""]), {}, ({ query }) =>
				Effect.gen(function* () {
					const request = { query: "row", capability: "all" as const, pageSize: 50 };
					expect((yield* query.search(request)).counts).toMatchObject({
						all: 2,
						editable: 1,
						readOnly: 1,
						withoutNotes: 1
					});
					const withoutNotes = yield* query.search({ ...request, withoutNotes: true });
					expect(withoutNotes.total).toBe(1);
					expect(withoutNotes.counts.readOnly).toBe(0);
					const readOnly = yield* query.search({ ...request, capability: "read_only" });
					expect(readOnly.total).toBe(1);
					expect(readOnly.counts.all).toBe(readOnly.total);
					expect(readOnly.counts.readOnly).toBe(readOnly.total);
					expect(
						(yield* query.search({
							...request,
							capability: "read_only",
							withoutNotes: true
						})).total
					).toBe(0);
					expect((yield* query.search({ ...request, query: "key:" })).total).toBe(0);
				})
			)
	);
});
describe("human CSV", () => {
	it.live(
		"preserves review signals from the scanned corpus when exporting a filtered selection",
		() => {
			// The first key has two texts across its locations; only that line is editable.
			const input = corpusOf(["same source", "same source"]);
			const corpus: TextCorpus = {
				...input,
				units: input.units.map((unit, index) =>
					index === 0
						? {
								...unit,
								source: {
									status: "conflicting",
									values: ["same source", "Same source"]
								},
								occurrences: unit.occurrences.map((occurrence, location) => ({
									...occurrence,
									source: location === 0 ? "same source" : "Same source"
								}))
							}
						: unit
				)
			};
			return withIndexedCorpus(corpus, {}, ({ query }) =>
				Effect.gen(function* () {
					const filtered = yield* query.exportWithSignals({
						query: "",
						capability: "source_editable"
					});
					expect(filtered.corpus.units).toHaveLength(1);
					expect(formatCsv(filtered.corpus, filtered.reviewSignals)).toContain(
						"key has different text"
					);
				})
			);
		}
	);
	it.live(
		"protects metadata cells and uses the same UTF-16 character count as focus and checks",
		() => {
			const input = corpusOf(["😀"]);
			const corpus: TextCorpus = {
				...input,
				units: input.units.map((unit) => ({
					...unit,
					occurrences: unit.occurrences.map((occurrence) => ({
						...occurrence,
						devNotes: " \t@notes",
						identity: { status: "resolved", namespace: "-namespace", key: "+key" }
					}))
				}))
			};
			const csv = corpusCsvForTest(corpus);
			expect(csv).toContain('"😀","\' \t@notes","\'+key","\'-namespace"');
			expect(csv).toContain('"Yes","2","1"');
			const rules = {
				...STARTER_GAME_TEXT_RULES,
				rules: STARTER_GAME_TEXT_RULES.rules.map((rule) =>
					rule.kind === "character_budget" ? { ...rule, maximumCharacters: 1 } : rule
				)
			};
			const report = indexedTestReports(corpus).source(rules);
			expect(report.findings[0]?.actual).toMatchObject({ characterCount: 2 });
			expect(gameTextQualityCsv(report, indexedTestReports(corpus).corpus())).toContain(
				'"\'+key","\'-namespace"'
			);
			expect(gameTextQualityCsv(report, indexedTestReports(corpus).corpus())).toContain(
				"Maximum 1 character · 2 characters"
			);
			return withIndexedCorpus(corpus, {}, ({ query }) =>
				Effect.gen(function* () {
					const id = (yield* query.search({ query: "", capability: "all", pageSize: 1 }))
						.units[0]!.id;
					expect((yield* query.focus({ id, pageSize: 50 }))?.unit.characterCount).toBe(2);
				})
			);
		}
	);
	it("keeps String Table keys and asset property paths exact in both exports", () => {
		const input = corpusOf(["row placeholder"]);
		const corpus: TextCorpus = {
			...input,
			units: input.units.map((unit) => ({
				...unit,
				occurrences: unit.occurrences.map((occurrence, index) => ({
					...occurrence,
					location:
						index === 0
							? {
									kind: "string_table_entry",
									objectPath: "/Game/Text/ST_Game.ST_Game",
									entryKey: "PromptHold"
								}
							: {
									kind: "asset_property",
									objectPath: "/Game/Text/DA_Localization.DA_Localization",
									classPath: "/Script/Engine.DataAsset",
									propertyPath: "EqualSourceFirst"
								}
				}))
			}))
		};
		const report = indexedTestReports(corpus).source(STARTER_GAME_TEXT_RULES);
		for (const csv of [
			corpusCsvForTest(corpus),
			gameTextQualityCsv(report, indexedTestReports(corpus).corpus())
		]) {
			expect(csv).toContain('"String table entry","ST_Game","PromptHold",""');
			expect(csv).toContain('"Asset property","DA_Localization","","EqualSourceFirst"');
		}
	});
	it("keeps each conflicting location's own source rather than joining variants", () => {
		const input = corpusOf(["first"]);
		const csv = corpusCsvForTest({
			...input,
			units: input.units.map((unit) => ({
				...unit,
				source: { status: "conflicting", values: ["first", "second"] },
				occurrences: unit.occurrences.map((occurrence, index) => ({
					...occurrence,
					source: index === 0 ? "first" : "second"
				}))
			}))
		});
		expect(csv).toContain('\r\n"first",');
		expect(csv).toContain('\r\n"second",');
		expect(csv).not.toContain('"first second"');
	});
	it("quotes cells, doubles quotes, preserves newlines, and protects formulas before whitespace", () => {
		const csv = corpusCsvForTest(
			corpusOf(['=SUM(1,2) "quoted"\nnext', " +cmd", "-cmd", "@cmd"])
		);
		expect(csv.startsWith('\uFEFF"Source","Translator notes"')).toBe(true);
		expect(csv.endsWith("\r\n")).toBe(true);
		expect(csv).toContain('"\'=SUM(1,2) ""quoted""\nnext"');
		for (const value of [" +cmd", "-cmd", "@cmd"]) expect(csv).toContain("\"'" + value + '"');
		expect(csv.split("Content/Text/DT_Examples.uasset")).toHaveLength(9);
		expect(csv).toContain('"global"');
		expect(csv).toContain('"Data table cell","DT_Examples","0","DisplayName"');
		expect(csv).not.toContain('"/Game/Text/DT_Examples.DT_Examples"');
	});
	it("exports each finding and affected location, including key and recovery", () => {
		const corpus = corpusOf(["row placeholder"]);
		const report = indexedTestReports(corpus).source(STARTER_GAME_TEXT_RULES);
		const csv = gameTextQualityCsv(report, indexedTestReports(corpus).corpus());
		expect(report.findings).toHaveLength(2);
		expect(csv.split("\r\n")).toHaveLength(6);
		expect(csv).toContain('"key:0","global"');
		expect(csv).toContain('"Data table cell","DT_Examples","1","DisplayName"');
		expect(csv).toContain('"Prefer “entry” · “row” at 0–3"');
		expect(csv.startsWith("\uFEFF")).toBe(true);
		expect(csv.endsWith("\r\n")).toBe(true);
	});
});
it("decodes the neutral starter document through the existing decoder", async () => {
	expect(await Effect.runPromise(decodeGameTextRuleDocument(STARTER_GAME_TEXT_RULES))).toEqual(
		Schema.decodeUnknownSync(GameTextRuleDocument)(STARTER_GAME_TEXT_RULES)
	);
});
