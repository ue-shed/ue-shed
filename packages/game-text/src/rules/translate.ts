import { resolveLocalizationChecks, type GameTextRuleDocument } from "../game-text-rules.js";
import type { BuiltInCheckId } from "../localization-check-ids.js";
import { prepareTextQualityRules } from "../quality.js";
import type { TextTerminologyEntry } from "../quality-schema.js";
import { expr as x } from "./builder.js";
import { exampleRules } from "./catalogue.js";
import type { Expr, Rule, RuleDocumentV4 } from "./schema.js";

const f = x.field,
	p = x.param,
	v = x.var,
	g = x.get,
	o = x.object;
const item = v("item");
const roleOccurrences = (role: string) => x.filter(x.occurrences(), x.matchesRole(item, role));
const matches = (text: Expr, term: Expr, caseSensitive: Expr) =>
	x.termMatches(text, term, caseSensitive);
const terms = (entries: readonly TextTerminologyEntry[]) =>
	entries.flatMap((entry) =>
		(entry.kind === "forbidden" ? [entry.term] : [...entry.alternatives].sort()).map(
			(term) => ({
				term,
				expectation:
					entry.kind === "forbidden"
						? { kind: "forbidden_term", term: entry.term }
						: {
								discouragedTerm: term,
								kind: "preferred_term",
								preferredTerm: entry.term
							}
			})
		)
	);

/** Translate the effective v1–v3 policy into the one native expression language. */
export function translateRuleDocument(
	document: GameTextRuleDocument | undefined,
	options: {
		readonly checks?: readonly BuiltInCheckId[];
		readonly disabledChecks?: readonly BuiltInCheckId[];
	} = {}
): RuleDocumentV4 {
	const resolved = resolveLocalizationChecks(document);
	const sourceRules = document ? prepareTextQualityRules(document) : [];
	const rules: Rule[] = exampleRules.map((definition) => {
		// SAFETY: exampleRules only contains catalogue check IDs.
		// Verified by: rules/schema.test.ts checks catalogue coverage and translated settings.
		const id = definition.id as BuiltInCheckId;
		const setting = resolved[id];
		const params = {
			...definition.params,
			...setting.params,
			...(id === "placeholder_translation"
				? {
						sourceMarkers: resolved.placeholder_text.params.markers,
						sourcePhrases: resolved.placeholder_text.params.phrases
					}
				: undefined),
			...(id === "placeholder_text"
				? {
						sourceTerminology: sourceRules.flatMap(({ rule, role, terms }) =>
							rule.kind === "terminology"
								? [
										{
											role: role.id,
											caseSensitive: rule.caseSensitive,
											terms: terms.map(({ term }) => term)
										}
									]
								: []
						)
					}
				: undefined)
		};
		return {
			...definition,
			enabled:
				setting.enabled &&
				!options.disabledChecks?.includes(id) &&
				(!options.checks || options.checks.includes(id)),
			severity: setting.severity,
			...(setting.scope ? { scope: setting.scope } : undefined),
			params
		};
	});
	const used = new Set(exampleRules.flatMap((rule) => [rule.id, rule.ruleId ?? rule.id]));
	const authored = (family: Rule["family"], id: string) => {
		const translated = used.has(id) ? `${family}:${id}` : id;
		used.add(translated);
		return { id: translated, ruleId: id };
	};
	for (const { rule, role, terms: preparedTerms } of sourceRules) {
		const base = {
			...authored("source", rule.id),
			label: rule.id,
			subject: "unit_source",
			family: "source",
			severity: "normal",
			kind: rule.kind,
			role: role.id,
			recovery: rule.recovery,
			affected: roleOccurrences(role.id)
		} as const;
		if (rule.kind === "character_budget")
			rules.push({
				...base,
				params: { maximumCharacters: rule.maximumCharacters },
				when: x.and(
					x.gt(x.count(base.affected), 0),
					x.gt(x.utf16Length(f("source")), p("maximumCharacters"))
				),
				actual: o({
					characterCount: x.utf16Length(f("source")),
					kind: "character_count",
					source: f("source")
				}),
				expectation: o({
					kind: "maximum_characters",
					maximumCharacters: p("maximumCharacters")
				})
			});
		else
			rules.push({
				...base,
				params: {
					terms: preparedTerms.map(({ entry, term }) => ({
						term,
						expectation: terms([entry]).find((value) => value.term === term)!
							.expectation
					})),
					caseSensitive: rule.caseSensitive
				},
				each: x.flatMap(
					p("terms"),
					x.map(
						matches(f("source"), g(v("term"), "term"), p("caseSensitive")),
						o({ match: item, expectation: g(v("term"), "expectation") })
					),
					"term"
				),
				when: x.gt(x.count(base.affected), 0),
				actual: o({
					end: g(item, "match.end"),
					kind: "terminology_match",
					source: f("source"),
					start: g(item, "match.start"),
					term: g(item, "match.match")
				}),
				expectation: g(item, "expectation")
			});
	}
	const policy =
		document && document.schemaVersion !== 1 ? (document.localizationRules ?? []) : [];
	for (const rule of [...policy].sort((a, b) => a.id.localeCompare(b.id))) {
		if (!document?.roles.some((role) => role.id === rule.role)) continue;
		const affected = roleOccurrences(rule.role);
		const base = {
			...authored("policy", rule.id),
			kind: rule.kind,
			label: rule.id,
			subject: "line_culture",
			family: "policy",
			severity: rule.severity ?? "normal",
			role: rule.role,
			recovery: rule.recovery,
			affected
		} as const;
		const eligible = x.and(
			x.not(x.isNull(f("line.identity"))),
			x.gt(x.utf16Length(x.trim(f("line.source"))), 0),
			x.eq(f("line.originKind"), "corpus"),
			x.not(x.isNull(f("latest"))),
			x.gt(x.count(affected), 0)
		);
		if (rule.kind === "localization_character_budget") {
			const maximum = x.coalesce(
				g(p("cultures"), f("culture")),
				p("defaultMaximumCharacters")
			);
			rules.push({
				...base,
				params: {
					cultures: rule.cultures,
					defaultMaximumCharacters: rule.defaultMaximumCharacters ?? null
				},
				when: x.and(eligible, x.gt(x.utf16Length(f("latest")), maximum)),
				actual: o({
					kind: "character_count",
					characterCount: x.utf16Length(f("latest")),
					translation: f("latest")
				}),
				expectation: o({ kind: "maximum_characters", maximumCharacters: maximum })
			});
		} else
			rules.push({
				...base,
				params: {
					cultures: Object.fromEntries(
						Object.entries(rule.cultures).map(([culture, entries]) => [
							culture,
							terms(entries)
						])
					),
					caseSensitive: rule.caseSensitive
				},
				each: x.flatMap(
					x.coalesce(g(p("cultures"), f("culture")), x.list()),
					x.map(
						matches(f("latest"), g(v("term"), "term"), p("caseSensitive")),
						o({ match: item, expectation: g(v("term"), "expectation") })
					),
					"term"
				),
				when: eligible,
				actual: o({
					kind: "terminology_match",
					translation: f("latest"),
					start: g(item, "match.start"),
					end: g(item, "match.end"),
					term: g(item, "match.match")
				}),
				expectation: g(item, "expectation")
			});
	}
	for (const check of document?.schemaVersion === 3 ? (document.customChecks ?? []) : []) {
		const text = check.subject === "source" ? f("comparisonSource") : f("latest");
		const eligible =
			check.subject === "source"
				? x.and(x.not(x.isNull(f("identity"))), x.not(x.isNull(f("sourceCulture"))))
				: x.and(
						x.not(x.isNull(f("line.identity"))),
						x.not(f("isNative")),
						x.not(x.isNull(text))
					);
		const base = {
			...authored("custom", check.id),
			label: check.label,
			kind: "custom",
			subject: check.subject === "source" ? "line" : "line_culture",
			family: "custom",
			severity: check.severity ?? "normal",
			recovery: check.recovery,
			...(check.scope ? { scope: check.scope } : undefined),
			extra: o({ check: check.kind, label: check.label, subject: check.subject }),
			...(check.subject === "source" ? { translationOrigin: "absent" } : undefined)
		} as const;
		if (check.kind === "length") {
			const length = check.measure === "visible" ? x.visibleLength(text) : x.codePoints(text);
			rules.push({
				...base,
				when: x.and(
					eligible,
					x.or(
						...(check.minimum === undefined ? [] : [x.lt(length, check.minimum)]),
						...(check.maximum === undefined ? [] : [x.gt(length, check.maximum)])
					)
				),
				actual: o({ text, length }),
				expectation: o({
					measure: check.measure,
					...(check.minimum === undefined ? undefined : { minimum: check.minimum }),
					...(check.maximum === undefined ? undefined : { maximum: check.maximum })
				})
			});
		} else if (check.kind === "pattern") {
			const report = check.report ?? "match";
			const found = x.regexMatches(
				text,
				check.pattern,
				o({ caseSensitive: check.caseSensitive !== false, cap: 16 })
			);
			rules.push({
				...base,
				let: { matches: found },
				when: x.and(
					eligible,
					report === "match"
						? x.gt(x.count(v("matches")), 0)
						: x.eq(x.count(v("matches")), 0)
				),
				actual: o({
					text,
					...(report === "match"
						? {
								matches: x.filter(
									v("matches"),
									x.gt(x.utf16Length(g(item, "match")), 0)
								)
							}
						: undefined)
				}),
				expectation: o({ pattern: check.pattern, report })
			});
		} else {
			const found = x.take(
				x.sortByStart(
					x.flatMap(x.lit(check.terms), matches(text, item, check.caseSensitive))
				),
				16
			);
			rules.push({
				...base,
				let: { matches: found },
				when: x.and(eligible, x.gt(x.count(v("matches")), 0)),
				actual: o({ text, matches: v("matches") }),
				expectation: o({ terms: x.lit(check.terms) })
			});
		}
	}
	return { schemaVersion: 4, roles: document?.roles ?? [], rules };
}

/** Canonical v4 JSON retains rule and evidence-key order, and omits disabled rules. */
export function canonicalRuleDocument(document: RuleDocumentV4): string {
	return JSON.stringify({
		...document,
		rules: document.rules.filter((rule) => rule.enabled !== false)
	});
}
