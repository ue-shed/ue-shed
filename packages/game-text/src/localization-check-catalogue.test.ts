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
import {
	lengthOutlier,
	lengthOutlierMinimumRatio,
	placeholderMatches,
	placeholderMatchRanges,
	placeholderTranslation
} from "./native-text-shape.test-support.js";
import { consistentTranslationCandidate } from "./localization-text-shape.js";

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

	it("runs the text-shape helpers on parameters", () => {
		const source = "A fairly long sentence about the harbour";
		expect(lengthOutlier(source, "Hafen")).toBeDefined();
		const relaxed = { ...localizationCheckDefaults.length_outlier, minimumRatio: 0.1 };
		expect(lengthOutlier(source, "Hafen", undefined, undefined, relaxed)).toBeUndefined();
		expect(lengthOutlierMinimumRatio("pt-BR", { ...relaxed, compactCultures: ["pt"] })).toBe(
			relaxed.compactMinimumRatio
		);
		expect(lengthOutlierMinimumRatio("pt-BR", relaxed)).toBe(0.1);
		const words = { ...localizationCheckDefaults.placeholder_translation, words: ["nyi"] };
		expect(placeholderTranslation("The harbour is closed.", "NYI", words)).toBe("NYI");
		expect(placeholderTranslation("The harbour is closed.", "skip", words)).toBeUndefined();
		const markers = { markers: ["WIP"], phrases: [] };
		expect(placeholderMatches("WIP: the harbour, TODO", markers)).toEqual(["WIP"]);
		expect(placeholderMatches("The harbour", { markers: [], phrases: [] })).toEqual([]);
		const words5 = { minimumLength: 3, maximumWords: 5 };
		expect(consistentTranslationCandidate("Open the old harbour gate")).toBe(false);
		expect(consistentTranslationCandidate("Open the old harbour gate", words5)).toBe(true);
	});

	it("matches project placeholders across Unicode scripts and literal punctuation", () => {
		const params = {
			markers: ["仮", "заглушка", "[WIP]", "TODO"],
			phrases: ["à traduire", "🔧"]
		};
		expect(placeholderMatches("😀 仮 /заглушка/ [WIP] TODO! À TRADUIRE 🔧", params)).toEqual([
			"仮",
			"заглушка",
			"[WIP]",
			"TODO",
			"À TRADUIRE",
			"🔧"
		]);
		expect(placeholderMatchRanges("😀 [WIP] 仮", params)).toEqual([
			{ match: "[WIP]", start: 3, end: 8 },
			{ match: "仮", start: 9, end: 10 }
		]);
		expect(
			placeholderMatches(
				"仮名 незаглушка заглушками X[WIP]Y éTODO TODOé _TODO TODO_ TODO\u0301",
				params
			)
		).toEqual([]);
		expect(placeholderMatches("todo Заглушка", params)).toEqual([]);
		expect(placeholderMatches("仮 [WIP]", { markers: [], phrases: [] })).toEqual([]);
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
