import { Schema } from "effect";
import { CultureCode } from "@ue-shed/localization/browser";
import type { LocalizationJoin } from "./localization-schema.js";
import {
	localizationRulesOf,
	type GameTextRuleDocument,
	type LocalizationProjectRule
} from "./game-text-rules.js";
import type { LocalizationRuleDiagnostic } from "./localization-quality-schema.js";
import type { TextRole } from "./quality-schema.js";

export type LocalizationPolicyRule = {
	readonly rule: LocalizationProjectRule;
	readonly role: TextRole;
};

/**
 * The file's localization rules that run, by ID, with their roles, and the diagnostics that need
 * no lines.
 */
export function localizationPolicyRules(
	cultures: LocalizationJoin["cultures"],
	document: GameTextRuleDocument
) {
	const diagnostics: LocalizationRuleDiagnostic[] = [];
	const rules: LocalizationPolicyRule[] = [];
	const roles = new Map(document.roles.map((role) => [role.id, role]));
	for (const rule of localizationRulesOf(document).sort((a, b) => a.id.localeCompare(b.id))) {
		for (const key of Object.keys(rule.cultures).sort()) {
			const culture = Schema.decodeUnknownSync(CultureCode)(key);
			if (!cultures.includes(culture))
				diagnostics.push({
					code: "rule_culture_not_in_target",
					severity: "warning",
					culture,
					ruleId: rule.id,
					recovery:
						"Keep project-wide cultures when intentional, or correct the culture in this rule."
				});
		}
		const role = roles.get(rule.role);
		if (role) rules.push({ rule, role });
	}
	return { rules, diagnostics };
}
