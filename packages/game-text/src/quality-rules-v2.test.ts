import { Effect, Schema } from "effect";
import { it } from "@effect/vitest";
import { expect } from "vitest";
import { readFileSync } from "node:fs";
import {
	decodeGameTextRuleDocumentJson,
	evaluateGameTextSourceQuality,
	TextQualityRuleDocumentV2
} from "./quality-rules-v2.js";
import { decodeTextQualityRuleDocumentJson } from "./quality-schema.js";
import { evaluateTextQuality } from "./quality.js";
import { STARTER_GAME_TEXT_RULES } from "./starter-rules.js";
import {
	archiveEntry,
	corpus,
	cultureCode,
	evidence,
	manifestEntry,
	poDocument,
	unit
} from "./localization.test-support.js";
import { checkLocalizationTarget } from "./localization-checks.js";
import { joinLocalizationTarget } from "./localization.js";
import { LocalizationQualityReport } from "./localization-quality-schema.js";

const authored = {
	schemaVersion: 2,
	roles: [
		{
			id: "menu",
			scopes: [{ matchers: [{ kind: "location_kind", value: "string_table_entry" }] }]
		}
	],
	rules: [],
	disabledLocalizationChecks: ["missing_translator_notes"],
	localizationRules: [
		{
			kind: "localization_character_budget",
			id: "menu.budget",
			role: "menu",
			cultures: { de: 4, ja: 5 },
			defaultMaximumCharacters: 6,
			recovery: "Shorten this translation."
		},
		{
			kind: "localization_terminology",
			id: "menu.terms",
			role: "menu",
			cultures: {
				de: [
					{ kind: "forbidden", term: "ALT" },
					{ kind: "preferred", term: "Neu", alternatives: ["alt"] }
				]
			},
			caseSensitive: false,
			recovery: "Use the authored glossary."
		}
	]
};
it.effect("preserves v1 decoding and evaluation, including the starter", () =>
	Effect.gen(function* () {
		const json = JSON.stringify(STARTER_GAME_TEXT_RULES);
		const v1 = yield* decodeTextQualityRuleDocumentJson(json);
		const union = yield* decodeGameTextRuleDocumentJson(json);
		expect(union).toEqual(v1);
		expect(evaluateGameTextSourceQuality(corpus(), union)).toEqual(
			evaluateTextQuality(corpus(), v1)
		);
	})
);
it.effect("rejects malformed JSON with safe syntax recovery", () =>
	Effect.gen(function* () {
		const error = yield* decodeGameTextRuleDocumentJson("{secret-project-term").pipe(
			Effect.flip
		);
		expect(error._tag).toBe("GameTextRuleDocumentError");
		expect(error.code).toBe("invalid_json");
		expect(error.message).toContain("not valid JSON");
		expect(error.recovery).toContain("Correct the JSON syntax");
		expect(`${error.message} ${error.recovery}`).not.toContain("secret-project-term");
	})
);
it.effect("decodes the packaged v2 example and retains source rules in v2 source evaluation", () =>
	Effect.gen(function* () {
		const example = yield* decodeGameTextRuleDocumentJson(
			readFileSync(new URL("../fixtures/quality-rules.v2.json", import.meta.url), "utf8")
		);
		expect(example.schemaVersion).toBe(2);
		const document = yield* decodeGameTextRuleDocumentJson(
			JSON.stringify({
				...authored,
				rules: [
					{
						kind: "character_budget",
						id: "source.budget",
						role: "menu",
						maximumCharacters: 3,
						recovery: "Shorten the source."
					}
				]
			})
		);
		const report = evaluateGameTextSourceQuality(corpus(), document);
		expect(report.ruleDocumentVersion).toBe(2);
		expect(report.findings).toMatchObject([
			{ kind: "character_budget", actual: { source: "Source", characterCount: 6 } }
		]);
	})
);
it.effect(
	"validates v2 policy, checks pending PO text, and warns about project-wide cultures",
	() =>
		Effect.gen(function* () {
			const document = yield* decodeGameTextRuleDocumentJson(JSON.stringify(authored));
			const text = corpus([unit("K", "Source")]);
			const files = evidence(
				[manifestEntry()],
				[archiveEntry("K", "Source", "OK")],
				poDocument("😀 ALT alt")
			);
			const report = checkLocalizationTarget(
				text,
				joinLocalizationTarget(text, files, files.target),
				files,
				{},
				document
			);
			expect(report.ruleDocumentVersion).toBe(2);
			expect(report.ruleDiagnostics).toMatchObject([
				{ severity: "warning", culture: "ja", code: "rule_culture_not_in_target" }
			]);
			const budgets = report.findings.filter(
				(finding) => finding.kind === "localization_character_budget"
			);
			expect(budgets.map((finding) => finding.culture)).toEqual(["de", "en"]);
			expect(budgets.every((finding) => finding.translationOrigin === "po")).toBe(true);
			const terms = report.findings.filter(
				(finding) => finding.kind === "localization_terminology"
			);
			expect(
				terms.map((finding) => [finding.culture, finding.actual.start, finding.actual.end])
			).toEqual([
				["de", 3, 6],
				["de", 3, 6],
				["de", 7, 10],
				["de", 7, 10]
			]);
			expect(
				report.findings.some((finding) => finding.kind === "missing_translator_notes")
			).toBe(false);
			expect(
				Schema.decodeUnknownSync(Schema.fromJsonString(LocalizationQualityReport))(
					JSON.stringify(report)
				)
			).toEqual(report);
			expect(report.coverage).toEqual(text.coverage);
		})
);
it.effect(
	"fails duplicate culture keys before JSON can discard them, invalid terms, budgets and roles",
	() =>
		Effect.gen(function* () {
			const json = JSON.stringify(authored);
			for (const input of [
				json.replace('"de":4', '"de":4,"\\u0064e":5'),
				json.replace('"de":4', '"de":0'),
				json.replace('"term":"ALT"', '"term":" "'),
				json.replace('"role":"menu"', '"role":"missing"')
			]) {
				const result = yield* decodeGameTextRuleDocumentJson(input).pipe(Effect.result);
				expect(result._tag).toBe("Failure");
			}
			const result = yield* decodeGameTextRuleDocumentJson(
				json.replace('"de":4', '"de":4,"de":5')
			).pipe(Effect.result);
			if (result._tag !== "Failure") throw new Error("Duplicate cultures were accepted.");
			expect(result.failure.code).toBe("duplicate_culture_key");
		})
);
it("omits unlisted culture policies without a default and preserves case-sensitive offsets", () => {
	const document = Schema.decodeUnknownSync(Schema.fromJsonString(TextQualityRuleDocumentV2))(
		JSON.stringify(authored)
			.replace(',"defaultMaximumCharacters":6', "")
			.replace('"caseSensitive":false', '"caseSensitive":true')
	);
	const text = corpus(),
		files = evidence(
			[manifestEntry()],
			[archiveEntry("K", "Source", "😀 ALT")],
			poDocument("😀 ALT")
		);
	const report = checkLocalizationTarget(
		text,
		joinLocalizationTarget(text, files, files.target),
		files,
		{},
		document
	);
	expect(
		report.findings
			.filter((finding) => finding.kind === "localization_character_budget")
			.map((finding) => finding.culture)
	).toEqual([cultureCode("de")]);
	expect(
		report.findings
			.filter((finding) => finding.kind === "localization_terminology")
			.map((finding) => finding.actual)
	).toEqual([
		{ kind: "terminology_match", translation: "😀 ALT", term: "ALT", start: 3, end: 6 }
	]);
});
