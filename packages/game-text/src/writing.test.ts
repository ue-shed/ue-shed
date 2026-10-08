import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { gameTextCsv, gameTextQualityCsv } from "./csv.js";
import { textCorpusQuery } from "./query.js";
import { evaluateTextQuality } from "./quality.js";
import { decodeTextQualityRuleDocument, TextQualityRuleDocument } from "./quality-schema.js";
import { STARTER_GAME_TEXT_RULES } from "./starter-rules.js";
import {
	type TextCorpus,
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
	it("uses searchable lines for search, summary and role coverage without changing scan provenance", () => {
		const corpus = corpusOf(["row one", "row two", "", " \n "]);
		const query = textCorpusQuery(corpus);
		const page = query.search({ query: "", capability: "all", pageSize: 50 });
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
				units: Array.from({ length: 51 }, () => page.units[0])
			})
		).toThrow();
		expect(query.search({ query: "", capability: "all", pageSize: 1 }).counts).toEqual(
			page.counts
		);
		expect(page.total).toBe(2);
		expect(page.counts.all).toBe(page.total);
		expect(query.summary().counts).toEqual(page.counts);
		expect(query.summary().review).toMatchObject({ all: 2, shared: 2, unresolved: 0 });
		expect(query.summary().sources.dataTable).toBe(2);
		expect(query.summary().searchable).toEqual({ textUnits: 2, textOccurrences: 4 });
		expect(query.summary().coverage).toEqual(corpus.coverage);
		const report = evaluateTextQuality(corpus, STARTER_GAME_TEXT_RULES);
		expect(report.roles.every((role) => role.matchedTextUnits === 2)).toBe(true);
		expect(report.roles.every((role) => role.matchedOccurrences === 4)).toBe(true);
	});

	it("counts the current query and filters, and requires every location to have blank notes", () => {
		const query = textCorpusQuery(corpusOf(["row one", "row two", "other", ""]));
		const request = { query: "row", capability: "all" as const, pageSize: 50 };
		expect(query.search(request).counts).toMatchObject({
			all: 2,
			shared: 2,
			editable: 1,
			readOnly: 1,
			withoutNotes: 1
		});
		expect(query.search({ ...request, withoutNotes: true }).total).toBe(1);
		expect(query.search({ ...request, withoutNotes: true }).counts.readOnly).toBe(0);
		const readOnly = query.search({ ...request, capability: "read_only" });
		expect(readOnly.total).toBe(1);
		expect(readOnly.counts.all).toBe(readOnly.total);
		expect(readOnly.counts.readOnly).toBe(readOnly.total);
		expect(
			query.search({ ...request, capability: "read_only", withoutNotes: true }).total
		).toBe(0);
		const long = query.search({ ...request, lens: "long" });
		expect(long.counts.all).toBe(long.total);
		expect(long.total).toBe(0);
		expect(query.search({ ...request, query: "key:" }).total).toBe(0);
		const single = corpusOf(["row one", "row two"]);
		const unshared = textCorpusQuery({
			...single,
			units: single.units.map((unit) => ({
				...unit,
				occurrences: unit.occurrences.slice(0, 1)
			}))
		}).search(request);
		expect(unshared.counts).toMatchObject({ all: 2, shared: 0 });
	});
});

describe("human CSV", () => {
	it("preserves review signals from the scanned corpus when exporting a filtered selection", () => {
		const corpus = corpusOf(["same source", "same source"]);
		const filtered = textCorpusQuery(corpus).export({
			query: "",
			capability: "source_editable"
		});
		expect(filtered.units).toHaveLength(1);
		expect(gameTextCsv(filtered, corpus)).toContain("same text under another key");
	});

	it("protects metadata cells and uses the same UTF-16 character count as focus and checks", () => {
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
		const csv = gameTextCsv(corpus);
		expect(csv).toContain('"😀","\' \t@notes","\'+key","\'-namespace"');
		expect(csv).toContain('"Yes","2","1"');
		const id = corpus.units[0]!.id;
		expect(textCorpusQuery(corpus).focus({ id, pageSize: 50 })?.unit.characterCount).toBe(2);
		const rules = {
			...STARTER_GAME_TEXT_RULES,
			rules: STARTER_GAME_TEXT_RULES.rules.map((rule) =>
				rule.kind === "character_budget" ? { ...rule, maximumCharacters: 1 } : rule
			)
		};
		const report = evaluateTextQuality(corpus, rules);
		expect(report.findings[0]?.actual).toMatchObject({ characterCount: 2 });
		expect(gameTextQualityCsv(report, corpus)).toContain('"\'+key","\'-namespace"');
		expect(gameTextQualityCsv(report, corpus)).toContain("Maximum 1 character · 2 characters");
	});

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
		const report = evaluateTextQuality(corpus, STARTER_GAME_TEXT_RULES);
		for (const csv of [gameTextCsv(corpus), gameTextQualityCsv(report, corpus)]) {
			expect(csv).toContain('"String table entry","ST_Game","PromptHold",""');
			expect(csv).toContain('"Asset property","DA_Localization","","EqualSourceFirst"');
		}
	});

	it("keeps each conflicting location's own source rather than joining variants", () => {
		const input = corpusOf(["first"]);
		const csv = gameTextCsv({
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
		const csv = gameTextCsv(corpusOf(['=SUM(1,2) "quoted"\nnext', " +cmd", "-cmd", "@cmd"]));
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
		const report = evaluateTextQuality(corpus, STARTER_GAME_TEXT_RULES);
		const csv = gameTextQualityCsv(report, corpus);
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
	expect(await Effect.runPromise(decodeTextQualityRuleDocument(STARTER_GAME_TEXT_RULES))).toEqual(
		Schema.decodeUnknownSync(TextQualityRuleDocument)(STARTER_GAME_TEXT_RULES)
	);
});
