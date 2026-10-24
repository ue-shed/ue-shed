import { describe, expect, it } from "vitest";
import { BuiltInCheckId } from "../localization-check-ids.js";
import { TextRoleId, TextQualityRuleId } from "../quality-schema.js";
import { expr } from "./builder.js";
import { exampleRules } from "./catalogue.js";
import { ruleOperationNames } from "./schema.js";
import { STARTER_CHECK_RULES, STARTER_CHECKS } from "../starter-rules.js";
import { canonicalRuleDocument, effectiveRuleDocument } from "./effective.js";

describe("v4 rule documents", () => {
	it("covers every built-in with ordinary expressions; a file runs only what it lists", () => {
		expect(exampleRules.map((rule) => rule.id)).toEqual(
			expect.arrayContaining([...BuiltInCheckId.literals])
		);
		expect(exampleRules).toHaveLength(BuiltInCheckId.literals.length);
		expect(effectiveRuleDocument(undefined).rules).toEqual([]);
		const enabled = effectiveRuleDocument(STARTER_CHECK_RULES)
			.rules.filter((rule) => rule.enabled)
			.map((rule) => rule.id);
		expect(new Set(enabled)).toEqual(new Set(STARTER_CHECKS));
		expect(enabled).toHaveLength(BuiltInCheckId.literals.length - 3);
		expect(enabled).not.toContain("segment_separator");
		expect(enabled).not.toContain("shared");
		expect(enabled).not.toContain("long");
	});
	it("constructs every operator, with bare scalars as literals", () => {
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
			expr.maxOf("value"),
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
			expr.formatRenameArgument("a", "b", "c", "d"),
			expr.regexReplace("a", "b", "c"),
			expr.groupCount({ by: "a" }),
			expr.groupRank({ by: "a", order: expr.list("b") }),
			expr.groupTake({ by: "a", order: expr.list("b"), value: "c", n: 1 }),
			expr.groupTally({ by: "a", value: "b", display: "c" }),
			expr.existsOther({ over: expr.list("a"), by: "b", differing: expr.list("c") }),
			expr.corpusCount({ by: "a", key: "b" })
		];
		for (const expression of calls) {
			expect(Object.keys(expression)).toHaveLength(1);
			expect(ruleOperationNames).toContain(Object.keys(expression)[0]);
		}
		expect(expr.eq("a", 1)).toEqual({ eq: [{ lit: "a" }, { lit: 1 }] });
		expect(expr.object({ a: null })).toEqual({ object: { a: { lit: null } } });
		expect(expr.filter(expr.list(true), expr.var("x"), "x")).toEqual({
			filter: [{ list: [{ lit: true }] }, { var: "x" }, "x"]
		});
		expect(expr.findingField("a", "b")).toEqual({ findingField: ["a", "b"] });
		expect(expr.groupCount({ by: "a" })).toEqual({
			groupCount: { by: { lit: "a" } }
		});
		expect(expr.corpusCount({ by: "a", key: "b" })).toEqual({
			corpusCount: {
				relation: { lit: "corpus_occurrence" },
				by: { lit: "a" },
				key: { lit: "b" }
			}
		});
	});
	it("keeps effective check selection, parameters, references and evidence-key order", () => {
		const effective = effectiveRuleDocument(
			{
				schemaVersion: 1,
				roles: [],
				rules: [
					{ kind: "format_argument_renamed" },
					{ kind: "format_arguments", params: { optionalArguments: ["Player"] } }
				]
			},
			{ checks: ["format_arguments"], disabledChecks: ["format_argument_renamed"] }
		);
		expect(effective.rules.filter((rule) => rule.enabled).map((rule) => rule.id)).toEqual([
			"format_arguments"
		]);
		expect(effective.rules[0]?.params).toEqual({ optionalArguments: ["Player"] });
		const canonical = canonicalRuleDocument(effective);
		expect(JSON.parse(canonical).rules).toHaveLength(1);
		expect(canonical.indexOf('"arguments":')).toBeLessThan(canonical.indexOf('"missing":'));
	});
	it("keeps project rule IDs and derives parameters from the rules that run", () => {
		const role = TextRoleId.make("menu");
		const terms = (id: string, enabled: boolean) => ({
			kind: "terminology" as const,
			id: TextQualityRuleId.make(id),
			role,
			enabled,
			caseSensitive: true,
			terms: [{ kind: "forbidden" as const, term: id.toUpperCase() }],
			scope: { pathPrefixes: ["/Game/UI/"] },
			recovery: "Use the glossary."
		});
		const effective = effectiveRuleDocument({
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
				terms("off", false),
				{ kind: "placeholder_translation" },
				{ kind: "placeholder_text", enabled: false, params: { markers: ["XXX"] } },
				terms("on", true)
			]
		});
		// Built-in checks in catalogue order, then project rules.
		expect(effective.rules.map((rule) => [rule.id, rule.ruleId, rule.subject])).toEqual([
			["placeholder_translation", "localization.placeholder_translation", "line_culture"],
			["placeholder_text", "localization.placeholder_text", "line"],
			["on", "on", "unit_source"]
		]);
		expect(effective.rules[1]?.params?.sourceTerminology).toEqual([
			{
				role: "menu",
				caseSensitive: true,
				terms: ["ON"],
				scope: { pathPrefixes: ["/Game/UI/"] }
			}
		]);
		// A disabled placeholder_text still lends placeholder_translation its markers.
		expect(effective.rules[0]?.params).toMatchObject({
			sourceMarkers: ["XXX"],
			sourcePhrases: ["lorem ipsum", "to be translated", "placeholder"]
		});
	});
});
