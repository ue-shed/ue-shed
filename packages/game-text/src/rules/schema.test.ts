import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { BuiltInCheckId } from "../localization-check-ids.js";
import { TextRoleId, TextQualityRuleId } from "../quality-schema.js";
import { expr, rule } from "./builder.js";
import { exampleRules } from "./catalogue.js";
import { Expr, ruleDocumentJsonSchema } from "./schema.js";
import { canonicalRuleDocument, translateRuleDocument } from "./translate.js";
import { validateRuleDocument } from "./validate.js";

describe("v4 rule documents", () => {
	it("covers every Phase 1 built-in with ordinary expressions", () => {
		const group = new Set([
			"duplicate_source",
			"inconsistent_translation",
			"culture_invariant_text"
		]);
		expect(new Set(exampleRules.map((rule) => rule.id))).toEqual(
			new Set(BuiltInCheckId.literals.filter((id) => !group.has(id)))
		);
		expect(validateRuleDocument(translateRuleDocument(undefined)).rules).toHaveLength(22);
	});
	it("constructs and validates every operator, rejecting incorrect arities", () => {
		const decode = Schema.decodeUnknownSync(Expr);
		const calls = [
			expr.field("source"),
			expr.param("limit"),
			expr.var("item"),
			expr.finding("a"),
			expr.lit({ a: [1] }),
			expr.object({ a: 1 }),
			expr.list(1, 2),
			expr.occurrences(),
			expr.not("value"),
			expr.isNull("value"),
			expr.utf16Length("value"),
			expr.codePoints("value"),
			expr.visibleLength("value"),
			expr.visibleWords("value"),
			expr.interiorLineBreaks("value"),
			expr.trim("value"),
			expr.lower("value"),
			expr.normalizeLineEndings("value"),
			expr.count("value"),
			expr.flatten("value"),
			expr.distinct("value"),
			expr.first("value"),
			expr.sortByStart("value"),
			expr.formatArgumentNames("value"),
			expr.formatArgumentOrder("value"),
			expr.formatModifiers("value"),
			expr.formatIssues("value"),
			expr.formatCompiled("value"),
			expr.richTextCounts("value"),
			expr.richTextTagBalance("value"),
			expr.unrealWhitespace("value"),
			expr.unrealUnsafeWhitespace("value"),
			expr.formatBraceBalance("value"),
			expr.get("a", "b"),
			expr.eq("a", "b"),
			expr.ne("a", "b"),
			expr.lt("a", "b"),
			expr.le("a", "b"),
			expr.gt("a", "b"),
			expr.ge("a", "b"),
			expr.in("a", "b"),
			expr.sub("a", "b"),
			expr.div("a", "b"),
			expr.round("a", "b"),
			expr.startsWith("a", "b"),
			expr.endsWith("a", "b"),
			expr.contains("a", "b"),
			expr.countOccurrences("a", "b"),
			expr.findAll("a", "b"),
			expr.anyChar("a", "b"),
			expr.allChars("a", "b"),
			expr.removeClass("a", "b"),
			expr.leadingClass("a", "b"),
			expr.trailingClass("a", "b"),
			expr.take("a", "b"),
			expr.drop("a", "b"),
			expr.minus("a", "b"),
			expr.zip("a", "b"),
			expr.matchesRole("a", "b"),
			expr.pathHasPrefix("a", "b"),
			expr.formatPattern("a", "b"),
			expr.richTextValid("a", "b"),
			expr.compareRichTextTags("a", "b"),
			expr.withoutOptionalArgumentTags("a", "b"),
			expr.findingField("a", "b"),
			expr.if("a", "b", "c"),
			expr.slice("a", "b", "c"),
			expr.trimClass("a", "b", "c"),
			expr.runs("a", "b", "c"),
			expr.regexMatches("a", "b", "c"),
			expr.regexTest("a", "b", "c"),
			expr.termMatches("a", "b", "c"),
			expr.and("a", "b"),
			expr.or("a", "b"),
			expr.coalesce("a", "b"),
			expr.add("a", "b"),
			expr.mul("a", "b"),
			expr.min("a", "b"),
			expr.max("a", "b"),
			expr.concat("a", "b"),
			expr.concatLists("a", "b"),
			expr.filter(expr.list(1), true, "item"),
			expr.map(expr.list(1), true, "item"),
			expr.flatMap(expr.list(1), true, "item"),
			expr.any(expr.list(1), true, "item"),
			expr.all(expr.list(1), true, "item"),
			expr.sortCodeUnit(expr.list(1)),
			expr.sortCodeUnit(expr.list(1), expr.var("item")),
			expr.sortLocale(expr.list(1)),
			expr.sortLocale(expr.list(1), expr.var("item")),
			expr.termListMatches("a", "b", "c", "d"),
			expr.formatRenameArgument("a", "b", "c", "d")
		];
		for (const expression of calls)
			expect(decode(expression, { onExcessProperty: "error" })).toEqual(expression);
		expect(() => decode({ eq: [1] })).toThrow();
		expect(() => decode({ unknown: [] })).toThrow();
	});
	it("keeps effective check selection, parameters, references and evidence-key order", () => {
		const translated = translateRuleDocument(
			{
				schemaVersion: 3,
				roles: [],
				rules: [],
				checks: { format_arguments: { params: { optionalArguments: ["Player"] } } }
			},
			{ checks: ["format_arguments"], disabledChecks: ["format_argument_renamed"] }
		);
		expect(translated.rules.filter((rule) => rule.enabled).map((rule) => rule.id)).toEqual([
			"format_arguments"
		]);
		expect(translated.rules[0]?.params).toEqual({ optionalArguments: ["Player"] });
		const canonical = canonicalRuleDocument(translated);
		expect(JSON.parse(canonical).rules).toHaveLength(1);
		expect(canonical.indexOf('"arguments":')).toBeLessThan(canonical.indexOf('"missing":'));
	});
	it("names colliding authored rules without changing the emitted rule ID", () => {
		const role = TextRoleId.make("all");
		const translated = translateRuleDocument({
			schemaVersion: 1,
			roles: [
				{
					id: role,
					scopes: [
						{ matchers: [{ kind: "object_path", operator: "prefix", value: "/Game/" }] }
					]
				}
			],
			rules: [
				{
					id: TextQualityRuleId.make("localization.format_arguments"),
					role,
					kind: "character_budget",
					maximumCharacters: 4,
					recovery: "Shorten it."
				}
			]
		});
		expect(translated.rules.at(-1)).toMatchObject({
			id: "source:localization.format_arguments",
			ruleId: "localization.format_arguments",
			subject: "unit_source"
		});
	});
	it("rejects missing parameters, duplicate IDs, undeclared roles and reference cycles", () => {
		const base = rule({
			id: "a",
			kind: "a",
			label: "A",
			subject: "line",
			family: "builtin",
			severity: "low",
			when: true,
			actual: expr.object({}),
			expectation: expr.object({}),
			recovery: "Review it."
		});
		const document = (rules: readonly (typeof base)[]) => ({
			schemaVersion: 4,
			roles: [],
			rules
		});
		expect(() =>
			validateRuleDocument(document([{ ...base, when: expr.param("missing") }]))
		).toThrow();
		expect(() => validateRuleDocument(document([base, base]))).toThrow();
		expect(() => validateRuleDocument(document([{ ...base, role: "missing" }]))).toThrow();
		expect(() =>
			validateRuleDocument(document([{ ...base, when: expr.finding("a") }]))
		).toThrow(expect.objectContaining({ code: "rule_cycle" }));
	});
	it("checks in the generated JSON Schema", () => {
		expect(
			JSON.parse(
				readFileSync(new URL("./rule-document.schema.json", import.meta.url), "utf8")
			)
		).toEqual(ruleDocumentJsonSchema);
	});
});
