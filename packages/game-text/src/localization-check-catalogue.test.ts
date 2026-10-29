import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { BuiltInCheckId } from "./localization-check-ids.js";
import {
	LengthOutlierParams,
	localizationCheckCatalogue,
	localizationCheckDefaults,
	localizationRuleId,
	parseLocalizationRuleId
} from "./localization-check-catalogue.js";
import {
	CHECK_TABLE_START,
	CHECK_TABLE_END,
	checkTableCells,
	localizationCheckRows,
	withLocalizationCheckTable
} from "./localization-check-table.js";
import { evaluateCatalogueRule } from "./native-text-shape.test-support.js";
import { nativeVisibleLength } from "./native-rule-reports.test-support.js";

const README = fileURLToPath(new URL("../README.md", import.meta.url));

describe("localization check catalogue", () => {
	it("describes every built-in check once, under its own ID", () => {
		expect(Object.keys(localizationCheckCatalogue)).toEqual([...BuiltInCheckId.literals]);
		for (const id of BuiltInCheckId.literals) {
			const check = localizationCheckCatalogue[id];
			expect(check.id).toBe(id);
			expect(check.label.length).toBeGreaterThan(0);
			expect(check.defaultCondition.length).toBeGreaterThan(0);
			expect(localizationCheckDefaults[id]).toBe(check.defaults);
		}
		expect(localizationCheckCatalogue.placeholder_text.subject).toBe("source");
		expect(localizationCheckCatalogue.missing_translator_notes.subject).toBe("source");
		expect(localizationCheckCatalogue.duplicate_source.subject).toBe("source");
		expect(localizationCheckCatalogue.length_outlier.subject).toBe("localization");
	});

	it("round-trips rule IDs and rejects project rules and unknown checks", () => {
		expect(localizationRuleId("length_outlier")).toBe("localization.length_outlier");
		for (const id of BuiltInCheckId.literals)
			expect(parseLocalizationRuleId(localizationRuleId(id))).toBe(id);
		expect(parseLocalizationRuleId("ui-budget")).toBeUndefined();
		expect(parseLocalizationRuleId("localization.no_such_check")).toBeUndefined();
	});

	it("decodes partial parameters over the defaults and rejects invalid ones", () => {
		const params = Schema.decodeUnknownSync(LengthOutlierParams)({ maximumRatio: 4 });
		expect(params).toEqual({ ...localizationCheckDefaults.length_outlier, maximumRatio: 4 });
		expect(() => Schema.decodeUnknownSync(LengthOutlierParams)({ minimumRatio: -1 })).toThrow();
		expect(localizationCheckCatalogue.length_outlier.condition(params)).toContain("four times");
	});

	it("emits catalogue evidence from explicit facts and parameter overrides", () => {
		const facts = {
			"line.checkable": true,
			"line.comparable": true,
			"line.comparisonSource": "A fairly long sentence about the harbour",
			latest: "Hafen",
			culture: "de",
			isNative: false
		};
		const found = evaluateCatalogueRule("length_outlier", facts);
		expect(found?.actual).toEqual({ length: 5, ratio: 0.13 });
		expect(found?.expectation).toEqual({
			sourceLength: 40,
			minimumRatio: 0.33,
			maximumRatio: 3
		});
		expect(
			evaluateCatalogueRule("length_outlier", facts, { minimumRatio: 0.1 })
		).toBeUndefined();
		expect(
			evaluateCatalogueRule(
				"length_outlier",
				{ ...facts, culture: "pt-BR" },
				{ compactCultures: ["pt"] }
			)?.expectation
		).toMatchObject({ minimumRatio: 0.25 });
		const translation = evaluateCatalogueRule(
			"placeholder_translation",
			{ ...facts, latest: "NYI" },
			{ words: ["nyi"] }
		);
		expect(translation?.actual).toEqual({ translation: "NYI" });
		expect(translation?.expectation).toEqual({ translatedText: true });
		expect(
			evaluateCatalogueRule(
				"placeholder_translation",
				{ ...facts, latest: "skip" },
				{ words: ["nyi"] }
			)
		).toBeUndefined();
	});

	it("emits literal Unicode placeholders without examining catalogue IR", () => {
		const params = {
			markers: ["仮", "заглушка", "[WIP]", "TODO"],
			phrases: ["à traduire", "🔧"]
		};
		const facts = {
			checkable: true,
			sourceVariants: null,
			source: "😀 仮 /заглушка/ [WIP] TODO! À TRADUIRE 🔧",
			comparisonSource: "",
			sourceCulture: "en"
		};
		const found = evaluateCatalogueRule("placeholder_text", facts, params);
		expect(found?.actual).toEqual({
			source: facts.source,
			matches: ["仮", "заглушка", "[WIP]", "TODO", "À TRADUIRE", "🔧"]
		});
		expect(found?.expectation).toEqual({ finalText: true });
		for (const source of [
			"仮名 незаглушка заглушками X[WIP]Y éTODO TODOé _TODO TODO_ TODO\u0301",
			"todo Заглушка"
		]) {
			expect(
				evaluateCatalogueRule("placeholder_text", { ...facts, source }, params)
			).toBeUndefined();
		}
		expect(
			evaluateCatalogueRule("placeholder_text", facts, { markers: [], phrases: [] })
		).toBeUndefined();
	});

	it("reports a String Table entry missing from a known table", () => {
		// The projector lists only references to a known table with no entry: a present entry
		// and a reference to an unscanned table both give an empty list, so neither fires.
		const missing = evaluateCatalogueRule("string_table_entry_missing", {
			sourceCulture: "en",
			missingStringTableEntries: [{ tableId: "/Game/Text/Table.Table", key: "Absent" }]
		});
		expect(missing?.actual).toEqual({
			entries: [{ tableId: "/Game/Text/Table.Table", key: "Absent" }],
			entryCount: 1
		});
		expect(missing?.expectation).toEqual({ entryExists: true });
		expect(
			evaluateCatalogueRule("string_table_entry_missing", {
				sourceCulture: "en",
				missingStringTableEntries: []
			})
		).toBeUndefined();
	});

	it("generates the README check table", () => {
		const readme = readFileSync(README, "utf8");
		const generated = withLocalizationCheckTable(readme);
		expect(generated, "the README has the check table markers").toBeDefined();
		if (process.env.UE_SHED_UPDATE_CHECK_TABLE === "1") {
			writeFileSync(README, generated!);
			return;
		}
		// Padding is the formatter's: compare cells. To update, rerun this test with
		// UE_SHED_UPDATE_CHECK_TABLE=1, then `pnpm exec oxfmt packages/game-text/README.md`.
		const table = (text: string) =>
			checkTableCells(
				text.slice(
					text.indexOf(CHECK_TABLE_START) + CHECK_TABLE_START.length,
					text.indexOf(CHECK_TABLE_END)
				)
			);
		expect(table(readme)).toEqual(table(generated!));
		expect(table(readme).slice(1)).toEqual(localizationCheckRows().map((row) => [...row]));
	});
});

// These edge cases are not planted in the saved fixture. Exercise the catalogue with explicit
// subject inputs, preserving the native rule's emitted evidence rather than old API shims.
const translationFacts = {
	"line.checkable": true,
	"line.comparable": true,
	"line.comparisonSource":
		"The rows are like a composition.//You left negative space. On purpose?",
	latest: "Leertaste drücken",
	culture: "de",
	isNative: false
};
const sourceFacts = {
	checkable: true,
	sourceVariants: null,
	comparisonSource: "",
	sourceCulture: "en",
	gathered: true,
	bytecodeOnly: false
};
it("compares rich-text tags by name and case", () => {
	const facts = {
		...translationFacts,
		"line.comparisonSource": 'Press <Key>Space</> or <img id="pad"/>'
	};
	const missing = evaluateCatalogueRule("rich_text_tags", facts);
	expect(missing?.actual).toMatchObject({ missing: ["Key", "img"], added: [] });
	expect(missing?.expectation).toEqual({ tags: ["Key", "img"] });
	const changed = evaluateCatalogueRule("rich_text_tag_case", {
		...translationFacts,
		"line.comparisonSource": "<Italic>Note</>",
		latest: "<italic>Hinweis</>"
	});
	expect(changed?.actual).toEqual({ changed: [{ source: "Italic", translation: "italic" }] });
	expect(changed?.expectation).toEqual({ sameCase: true });
	for (const source of ["a < b > c", "Plain"])
		expect(
			evaluateCatalogueRule("rich_text_tags", {
				...translationFacts,
				"line.comparisonSource": source,
				latest: source
			})
		).toBeUndefined();
});
it("measures visible length and flags only clear outliers", () => {
	expect(nativeVisibleLength("<b>Hi</> {Name}|plural(one=x,other=y)  there")).toBe(8);
	expect(nativeVisibleLength("  a  \tb \n")).toBe(3);
	expect(nativeVisibleLength("\u{20000}x")).toBe(3);
	expect(
		evaluateCatalogueRule("length_outlier", {
			...translationFacts,
			"line.comparisonSource": "Open the inventory to see items",
			latest: "打开背包查看物品"
		})
	).toBeUndefined();
	expect(
		evaluateCatalogueRule("length_outlier", {
			...translationFacts,
			"line.comparisonSource": "Short source",
			latest: "Eine sehr viel längere Übersetzung"
		})
	).toBeUndefined();
	for (const culture of ["zh-CN", "ja", "ko", "th-TH", "de", "id"]) {
		expect(
			evaluateCatalogueRule("length_outlier", {
				...translationFacts,
				culture,
				"line.comparisonSource": "A fairly long sentence about the harbour",
				latest: "Hafen"
			})?.expectation
		).toMatchObject({ minimumRatio: ["de", "id"].includes(culture) ? 0.33 : 0.25 });
	}
});
it("recognizes placeholder translations, Slate tag syntax and interior line breaks", () => {
	for (const latest of ["script lama", "Skip", "...", ".", "…", "-", "TBD"]) {
		const found = evaluateCatalogueRule("placeholder_translation", {
			...translationFacts,
			latest
		});
		expect(found?.actual).toEqual({ translation: latest });
		expect(found?.expectation).toEqual({ translatedText: true });
	}
	for (const [source, latest] of [
		[translationFacts["line.comparisonSource"], "Las filas son como una composición."],
		["...", "..."],
		["Okay", "OK"],
		["All", "Todo"],
		["TBD", "skip"],
		["tbd", "skip"],
		["xxx", "xxx"],
		["*exhales*", "..."]
	])
		expect(
			evaluateCatalogueRule("placeholder_translation", {
				...translationFacts,
				"line.comparisonSource": source!,
				latest: latest!
			})
		).toBeUndefined();
	expect(
		evaluateCatalogueRule("placeholder_translation", {
			...translationFacts,
			"line.comparisonSource": "Maybe the baby will settle down soon.",
			latest: "..."
		})?.actual
	).toEqual({ translation: "..." });
	for (const source of [
		"<invalid requirement type>",
		"GetWorld()->GetGameInstance()->GetSubsystem<UC_InputSubsystem>()",
		"<{playerColor}>{playerName}</>"
	])
		expect(evaluateCatalogueRule("source_markup", { ...sourceFacts, source })).toBeUndefined();
	const markup = evaluateCatalogueRule("source_markup", {
		...sourceFacts,
		source: "To join the festival, arrive between <timeAnd>19:00 and 22:00</timeAnd>."
	});
	expect(markup?.actual).toMatchObject({
		richText: { opening: 1, closing: 0 },
		xmlClosings: ["timeAnd"]
	});
	expect(markup?.expectation).toEqual({ balanced: true });
	const breaks = evaluateCatalogueRule("line_breaks", {
		...translationFacts,
		"line.comparisonSource": "Torn Pages\r\nA scrap\nof paper",
		latest: "Tu madre.\r\n"
	});
	expect(breaks?.actual).toEqual({ lineBreaks: 0 });
	expect(breaks?.expectation).toEqual({ lineBreaks: 2 });
	expect(
		evaluateCatalogueRule("line_breaks", {
			...translationFacts,
			"line.comparisonSource": "\r\n<PlayerName>{ParentLabel}</>，为什么？",
			latest: "Tu madre.\r\n"
		})
	).toBeUndefined();
});
it("finds placeholders, number-only text and source whitespace", () => {
	const found = evaluateCatalogueRule("placeholder_text", {
		...sourceFacts,
		source: "TODO: name, Lorem ipsum, To be translated"
	});
	expect(found?.actual).toEqual({
		source: "TODO: name, Lorem ipsum, To be translated",
		matches: ["TODO", "Lorem ipsum", "To be translated"]
	});
	expect(found?.expectation).toEqual({ finalText: true });
	expect(
		evaluateCatalogueRule("placeholder_text", { ...sourceFacts, source: "todo el mundo" })
	).toBeUndefined();
	for (const source of ["100", "3/4", "+25%", "1,000"]) {
		const found = evaluateCatalogueRule("number_only_text", { ...sourceFacts, source });
		expect(found?.actual).toEqual({ source });
		expect(found?.expectation).toEqual({ cultureInvariant: true });
	}
	for (const source of ["Level 5", "{0}%", "---", ""])
		expect(
			evaluateCatalogueRule("number_only_text", { ...sourceFacts, source })
		).toBeUndefined();
	const spaces = evaluateCatalogueRule("source_whitespace", {
		...sourceFacts,
		source: " Score:  10 "
	});
	expect(spaces?.actual).toEqual({
		source: " Score:  10 ",
		leading: " ",
		trailing: " ",
		repeatedSpaces: 1
	});
	expect(spaces?.expectation).toEqual({ trimmed: true });
});
