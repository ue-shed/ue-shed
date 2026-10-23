import { indexedTestReports } from "./indexed-reports.test-support.js";
import { nativeDetectCustom as detectCustomCheck } from "./native-rule-reports.test-support.js";
import { Effect, Schema } from "effect";
import { parsePO } from "@ue-shed/localization/browser";
import { describe, expect, it } from "vitest";
import {
	archiveEntry,
	corpus,
	evidence,
	manifestEntry,
	success,
	unit
} from "./localization.test-support.js";
import { joinLocalizationTarget } from "./localization.js";
import type {
	LocalizationCustomFinding,
	LocalizationQualityReport
} from "./localization-quality-schema.js";
import { LocalizationQualityReport as ReportSchema } from "./localization-quality-schema.js";
import {
	CustomLocalizationCheck,
	GameTextRuleDocument,
	TextQualityRuleDocumentV3,
	decodeGameTextRuleDocumentJson
} from "./game-text-rules.js";
import {
	localizationQualityWorkspace,
	workspaceQualityCsv,
	workspaceQualityLabel
} from "./localization-workspace.js";
const noPO = () => success(parsePO(new TextEncoder().encode("")));
type CustomChecks = NonNullable<(typeof TextQualityRuleDocumentV3.Encoded)["customChecks"]>;
const document = (customChecks: CustomChecks) =>
	Schema.decodeUnknownSync(GameTextRuleDocument)({
		schemaVersion: 3,
		roles: [
			{
				id: "ui",
				scopes: [
					{ matchers: [{ kind: "object_path", operator: "prefix", value: "/Game/UI/" }] }
				]
			}
		],
		rules: [],
		customChecks
	});
const failure = (customChecks: CustomChecks) => {
	const result = Effect.runSync(
		Effect.result(
			decodeGameTextRuleDocumentJson(
				JSON.stringify({ schemaVersion: 3, roles: [], rules: [], customChecks })
			)
		)
	);
	return result._tag === "Failure" ? result.failure.code : undefined;
};
/** Two gathered lines with German translations, saved under /Game/Text/. */
function check(rules: GameTextRuleDocument) {
	const text = corpus([unit("A", "Open the TODO gate"), unit("B", "Close")]);
	const files = evidence(
		[manifestEntry("A", "Open the TODO gate"), manifestEntry("B", "Close")],
		[
			archiveEntry("A", "Open the TODO gate", "Öffne das Tor, Held"),
			archiveEntry("B", "Close", "Schließen und danach zurück zum Hauptmenü gehen")
		],
		noPO()
	);
	const joined = joinLocalizationTarget(text, files, files.target);
	return { joined, report: indexedTestReports(text, files).localization(rules, {}) };
}
const custom = (report: LocalizationQualityReport) =>
	report.findings.filter(
		(finding): finding is LocalizationCustomFinding =>
			"kind" in finding && finding.kind === "custom"
	);
const base = { recovery: "Fix it.", label: "Custom" };
const decodeCheck = Schema.decodeUnknownSync(CustomLocalizationCheck);
describe("custom checks", () => {
	it("counts zero-width matches without inventing highlight spans", () => {
		for (const pattern of ["(?=TODO)", "^", "$"]) {
			const check = {
				...base,
				id: "anchor",
				kind: "pattern",
				subject: "source",
				pattern
			} as const;
			expect(detectCustomCheck(decodeCheck(check), "TODO")).toEqual({
				actual: { text: "TODO", matches: [] },
				expectation: { pattern, report: "match" }
			});
			expect(
				detectCustomCheck(decodeCheck({ ...check, report: "no_match" }), "TODO")
			).toBeUndefined();
		}
		const check = decodeCheck({
			...base,
			id: "lookahead",
			kind: "pattern",
			subject: "source",
			pattern: "(?=TODO)"
		});
		expect(detectCustomCheck(check, "Done")).toBeUndefined();
		expect(
			detectCustomCheck(decodeCheck({ ...check, report: "no_match" }), "Done")?.actual
		).toEqual({
			text: "Done"
		});
	});
	it("stops regex enumeration at the evidence limit or first no-match disproof", () => {
		const check = decodeCheck({
			...base,
			id: "dense",
			kind: "pattern",
			subject: "source",
			pattern: "."
		});
		const absent = decodeCheck({ ...check, report: "no_match" });
		const zero = decodeCheck({ ...check, pattern: "(?=.)" });
		const text = "😀".repeat(4096);
		const found = detectCustomCheck(check, text);
		expect(found?.actual.matches).toHaveLength(16);
		expect(found?.actual.matches?.at(-1)).toEqual({ match: "😀", start: 30, end: 32 });
		expect(detectCustomCheck(absent, text)).toBeUndefined();
		expect(detectCustomCheck(zero, text)?.actual.matches).toEqual([]);
	});
	it("checks present whitespace translations while respecting absence and scope", () => {
		const text = corpus([unit("Space", "A source"), unit("Absent", "Absent")]);
		const files = evidence(
			[manifestEntry("Space", "A source"), manifestEntry("Absent", "Absent")],
			[archiveEntry("Space", "A source", "  ")],
			noPO()
		);
		const joined = joinLocalizationTarget(text, files, files.target);
		const pattern = { ...base, kind: "pattern", pattern: "^\\s*$" } as const;
		expect(
			detectCustomCheck(
				decodeCheck({ ...pattern, id: "source-space", subject: "source" }),
				" "
			)?.actual
		).toEqual({ text: " ", matches: [{ match: " ", start: 0, end: 1 }] });
		const rules = document([
			{ ...pattern, id: "source-space", subject: "source" },
			{ ...pattern, id: "translation-space", subject: "translation" },
			{ ...pattern, id: "french", subject: "translation", scope: { cultures: ["fr"] } },
			{ ...pattern, id: "ui", subject: "source", scope: { roles: ["ui"] } }
		]);
		const found = custom(indexedTestReports(text, files).localization(rules, {}));
		expect(found.map(({ ruleId, culture, actual }) => [ruleId, culture, actual.text])).toEqual([
			["translation-space", "de", "  "]
		]);
		expect(
			custom(
				indexedTestReports(text, files).localization(rules, {
					culture: joined.cultures.find((culture) => culture === "de")!
				})
			).map(({ ruleId }) => ruleId)
		).toEqual(["translation-space"]);
	});
	it("validates custom checks with the rule file", () => {
		const pattern = {
			...base,
			id: "no-todo",
			kind: "pattern",
			subject: "source",
			pattern: "TODO"
		} as const;
		expect(failure([pattern])).toBeUndefined();
		expect(failure([{ ...pattern, pattern: "(" }])).toBe("invalid_structure");
		// The engine runs fixed-width lookbehinds only; JavaScript accepts both.
		expect(failure([{ ...pattern, pattern: "(?<=TO|O)DO" }])).toBeUndefined();
		expect(failure([{ ...pattern, pattern: "(?<=T+O)DO" }])).toBe("invalid_structure");
		expect(failure([{ ...pattern, id: "localization.mine" }])).toBe("invalid_structure");
		expect(
			failure([{ ...base, id: "len", kind: "length", subject: "source", measure: "visible" }])
		).toBe("invalid_structure");
		expect(
			failure([
				{
					...base,
					id: "len",
					kind: "length",
					subject: "source",
					measure: "visible",
					minimum: 5,
					maximum: 4
				}
			])
		).toBe("invalid_structure");
		expect(failure([pattern, pattern])).toBe("duplicate_rule_id");
		expect(failure([{ ...pattern, scope: { roles: ["ui"] } }])).toBe("unknown_role_id");
	});
	it("detects patterns, lengths and forbidden terms", () => {
		const pattern = {
			...base,
			id: "x",
			kind: "pattern",
			subject: "source",
			pattern: "\\bTODO\\b"
		} as const;
		expect(detectCustomCheck(decodeCheck(pattern), "A TODO here")?.actual.matches).toEqual([
			{ match: "TODO", start: 2, end: 6 }
		]);
		expect(detectCustomCheck(decodeCheck(pattern), "Done")).toBeUndefined();
		expect(detectCustomCheck(decodeCheck({ ...pattern, report: "no_match" }), "Done")).toEqual({
			actual: { text: "Done" },
			expectation: { pattern: "\\bTODO\\b", report: "no_match" }
		});
		expect(
			detectCustomCheck(decodeCheck({ ...pattern, caseSensitive: false }), "a todo")?.actual
				.matches
		).toHaveLength(1);
		const length = {
			...base,
			id: "y",
			kind: "length",
			subject: "translation",
			measure: "visible",
			maximum: 4
		} as const;
		expect(detectCustomCheck(decodeCheck(length), "<b>Gold</>")).toBeUndefined();
		expect(detectCustomCheck(decodeCheck(length), "Golden")?.actual.length).toBe(6);
		expect(
			detectCustomCheck(decodeCheck({ ...length, measure: "characters" }), "<b>Gold</>")
		).toBeDefined();
		const terms = {
			...base,
			id: "z",
			kind: "forbidden_term",
			subject: "translation",
			terms: ["Held"],
			caseSensitive: true
		} as const;
		expect(detectCustomCheck(decodeCheck(terms), "Hallo, Held!")?.actual.matches).toEqual([
			{ match: "Held", start: 7, end: 11 }
		]);
		expect(detectCustomCheck(decodeCheck(terms), "Heldin")).toBeUndefined();
	});
	it("reports custom findings beside the built-ins, scoped, rated and counted", () => {
		const rules = document([
			{
				...base,
				id: "no-todo",
				label: "No TODO",
				kind: "pattern",
				subject: "source",
				pattern: "TODO",
				severity: "blocking"
			},
			{
				...base,
				id: "short-de",
				label: "Short German",
				kind: "length",
				subject: "translation",
				measure: "visible",
				maximum: 30,
				scope: { cultures: ["de"] }
			},
			{
				...base,
				id: "short-fr",
				label: "Short French",
				kind: "length",
				subject: "translation",
				measure: "visible",
				maximum: 30,
				scope: { cultures: ["fr"] }
			},
			{
				...base,
				id: "no-held",
				label: "No Held",
				kind: "forbidden_term",
				subject: "translation",
				terms: ["Held"],
				caseSensitive: true,
				scope: { pathPrefixes: ["/Game/UI/"] }
			}
		]);
		const { joined, report } = check(rules);
		expect(Schema.decodeUnknownSync(ReportSchema)(report)).toEqual(report);
		const found = custom(report).map((finding) => [
			finding.ruleId,
			finding.culture,
			finding.severity
		]);
		expect(found).toEqual(
			expect.arrayContaining([
				["no-todo", "en", "blocking"],
				["short-de", "de", "normal"]
			])
		);
		// Out of scope: no French culture, and no saved place under /Game/UI/.
		expect(found.map(([ruleId]) => ruleId)).not.toContain("short-fr");
		expect(found.map(([ruleId]) => ruleId)).not.toContain("no-held");
		expect(report.rules.filter((rule) => !rule.ruleId.startsWith("localization."))).toEqual([
			{ ruleId: "no-todo", findingCount: 1 },
			{ ruleId: "short-de", findingCount: 1 },
			{ ruleId: "short-fr", findingCount: 0 },
			{ ruleId: "no-held", findingCount: 0 }
		]);
		expect(report.customChecks?.map((item) => item.label)).toEqual([
			"No TODO",
			"Short German",
			"Short French",
			"No Held"
		]);
		// The workspace lists each custom check as a filter with its label and count.
		const workspace = localizationQualityWorkspace(undefined, report, joined);
		const page = workspace.search({ target: joined.target, filter: "all" });
		expect(page.customFilters.map(({ filter }) => filter)).toEqual([
			"custom.no-todo",
			"custom.short-de",
			"custom.short-fr",
			"custom.no-held"
		]);
		expect(page.counts["custom.no-todo"]).toBe(1);
		expect(page.counts["custom.short-fr"]).toBe(0);
		const labels = new Map(page.customFilters.map(({ filter, label }) => [filter, label]));
		expect(workspaceQualityLabel("custom.short-de", labels)).toBe("Short German");
		const only = workspace.search({ target: joined.target, filter: "custom.short-de" });
		expect(only.findings).toHaveLength(1);
		expect(only.findings[0]?.problem).toContain("Short German");
		const csv = workspaceQualityCsv(
			workspace.export({ target: joined.target, filter: "custom.no-todo" })
		);
		expect(csv).toContain("No TODO");
	});
});
