import { Effect, Schema } from "effect";
import { parsePO } from "@ue-shed/localization/browser";
import { describe, expect, it } from "vitest";
import { indexedTestReports } from "./indexed-reports.test-support.js";
import {
	archiveEntry,
	corpus,
	evidence,
	manifestEntry,
	success,
	unit
} from "./localization.test-support.js";
import {
	LocalizationQualityReport,
	type LocalizationCustomFinding
} from "./localization-quality-schema.js";
import {
	CompleteRule,
	GameTextRuleDocument,
	customRulesOf,
	decodeGameTextRuleDocumentJson,
	ruleProblemError
} from "./game-text-rules.js";

const noPO = () => success(parsePO(new TextEncoder().encode("")));
type Entry = typeof CompleteRule.Encoded;
const document = (rules: ReadonlyArray<Entry>) =>
	Schema.decodeUnknownSync(GameTextRuleDocument)({ schemaVersion: 1, roles: [], rules });
const failure = (rules: ReadonlyArray<unknown>) => {
	const result = Effect.runSync(
		Effect.result(
			decodeGameTextRuleDocumentJson(JSON.stringify({ schemaVersion: 1, roles: [], rules }))
		)
	);
	return result._tag === "Failure" ? result.failure.code : undefined;
};
/** The spec's example: a translation with the mark. */
const exclamation = {
	kind: "rule",
	id: "ui.exclamation",
	label: "Exclamation mark in UI text",
	subject: "line_culture",
	severity: "low",
	params: { mark: "!" },
	when: { contains: [{ field: "latest" }, { param: "mark" }] },
	actual: { object: { translation: { field: "latest" } } },
	expectation: { object: { withoutMark: { lit: true } } },
	recovery: "Drop the exclamation mark."
} as const satisfies Entry;
const rule = (
	id: string,
	when: Entry["when"],
	subject: Entry["subject"] = "line_culture"
): Entry => ({
	kind: "rule",
	id,
	label: id,
	subject,
	when,
	actual: { object: {} },
	expectation: { object: {} },
	recovery: "Review it."
});
/** Two gathered lines with German translations; only A's has the mark. English is native. */
function reports() {
	const text = corpus([unit("A", "Open the gate"), unit("B", "Close")]);
	const files = evidence(
		[manifestEntry("A", "Open the gate"), manifestEntry("B", "Close")],
		[
			archiveEntry("A", "Open the gate", "Öffne das Tor!"),
			archiveEntry("B", "Close", "Schließen")
		],
		noPO(),
		[archiveEntry("A", "Open the gate", "Open the gate"), archiveEntry("B", "Close", "Close")]
	);
	return indexedTestReports(text, files);
}
const custom = (report: LocalizationQualityReport) =>
	report.findings.filter(
		(finding): finding is LocalizationCustomFinding =>
			"kind" in finding && finding.kind === "custom"
	);

describe("complete rules", () => {
	it("run as custom findings with check rule, in file order with custom checks", () => {
		const rules = document([
			exclamation,
			{
				...rule(
					"source.gate",
					{
						contains: [{ field: "comparisonSource" }, { lit: "gate" }]
					},
					"line"
				),
				actual: { object: { source: { field: "comparisonSource" } } }
			},
			rule("ui.loud", { finding: "ui.exclamation" })
		]);
		expect(customRulesOf(rules).map(({ id }) => id)).toEqual([
			"ui.exclamation",
			"source.gate",
			"ui.loud"
		]);
		const report = reports().localization(rules, {});
		const found = custom(report);
		expect(
			found
				.map(({ ruleId, check, subject, culture, severity }) => [
					ruleId,
					check,
					subject,
					culture,
					severity
				])
				.sort()
		).toEqual([
			["source.gate", "rule", "source", "en", "normal"],
			["ui.exclamation", "rule", "translation", "de", "low"],
			["ui.loud", "rule", "translation", "de", "normal"]
		]);
		const first = found.find(({ ruleId }) => ruleId === "ui.exclamation");
		expect(first).toMatchObject({
			label: "Exclamation mark in UI text",
			actual: { translation: "Öffne das Tor!" },
			expectation: { withoutMark: true },
			recovery: "Drop the exclamation mark."
		});
		expect(found.find(({ ruleId }) => ruleId === "source.gate")?.actual).toEqual({
			source: "Open the gate"
		});
		expect(report.customChecks).toEqual([
			{ ruleId: "ui.exclamation", label: "Exclamation mark in UI text" },
			{ ruleId: "source.gate", label: "source.gate" },
			{ ruleId: "ui.loud", label: "ui.loud" }
		]);
	});

	it("see keyed lines only, so every finding names its line", () => {
		const keyed = unit("A", "Open the gate");
		const unkeyed = unit("U", "Unkeyed");
		const keyless = { status: "unresolved", reason: "culture_invariant" } as const;
		const text = corpus([
			keyed,
			{
				...unkeyed,
				identity: keyless,
				occurrences: unkeyed.occurrences.map((place) => ({ ...place, identity: keyless }))
			}
		]);
		const files = evidence(
			[manifestEntry("A", "Open the gate")],
			[archiveEntry("A", "Open the gate", "Öffne das Tor")],
			noPO(),
			[archiveEntry("A", "Open the gate", "Open the gate")]
		);
		const report = indexedTestReports(text, files).localization(
			document([rule("all", { lit: true }, "line"), rule("every", { lit: true })]),
			{}
		);
		expect(() => Schema.decodeUnknownSync(LocalizationQualityReport)(report)).not.toThrow();
		expect(
			custom(report)
				.map(({ ruleId, identity }) => [ruleId, identity.key])
				.sort()
		).toEqual([
			["all", "A"],
			["every", "A"],
			["every", "A"]
		]);
	});
	it("report the rule at fault when the engine can't run it", () => {
		expect(() =>
			reports().localization(
				document([rule("a", { finding: "b" }), rule("b", { finding: "a" })]),
				{}
			)
		).toThrow(/reads its own findings through finding/u);
		expect(() => reports().localization(document([rule("odd", { unknown: [] })]), {})).toThrow(
			/“odd” has an expression the engine can't run/u
		);
		const error = ruleProblemError({
			ruleId: "odd",
			code: "invalid_expression",
			message: "Unknown operation unknown."
		});
		expect([error.code, error.ruleId]).toEqual(["invalid_expression", "odd"]);
		expect(ruleProblemError({ code: "invalid_structure", message: "x" }).code).toBe(
			"invalid_structure"
		);
	});

	it("decode only the file's fields", () => {
		expect(failure([exclamation])).toBeUndefined();
		expect(failure([{ ...exclamation, fix: { lit: "" } }])).toBe("invalid_structure");
		expect(failure([{ ...exclamation, family: "custom" }])).toBe("invalid_structure");
		const { when: _when, ...whenless } = exclamation;
		expect(failure([whenless])).toBe("invalid_structure");
		expect(failure([{ ...exclamation, subject: "unit_source" }])).toBe("invalid_structure");
		expect(failure([{ ...exclamation, id: "whitespace" }])).toBe("invalid_structure");
		expect(failure([exclamation, exclamation])).toBe("duplicate_rule_id");
	});
});
