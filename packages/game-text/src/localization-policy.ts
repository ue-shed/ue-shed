import { Schema } from "effect";
import { CultureCode } from "@ue-shed/localization/browser";
import type { LocalizationJoin } from "./localization-schema.js";
import type { TextQualityRuleDocumentV2, TextQualityRuleDocumentV3 } from "./game-text-rules.js";

/** A rule file with localization rules: version 2 or later. */
type PolicyDocument = TextQualityRuleDocumentV2 | TextQualityRuleDocumentV3;
import type { LocalizationRuleDiagnostic } from "./localization-quality-schema.js";

type LocalizationRule = NonNullable<PolicyDocument["localizationRules"]>[number];
type TextRole = PolicyDocument["roles"][number];
export type LocalizationPolicyRule = { readonly rule: LocalizationRule; readonly role: TextRole };

/** Rules in evaluation order with their roles, and the diagnostics that need no lines. */
export function localizationPolicyRules(
	cultures: LocalizationJoin["cultures"],
	document: PolicyDocument
) {
	const diagnostics: LocalizationRuleDiagnostic[] = [];
	const rules: LocalizationPolicyRule[] = [];
	const roles = new Map(document.roles.map((role) => [role.id, role]));
	for (const rule of [...(document.localizationRules ?? [])].sort((a, b) =>
		a.id.localeCompare(b.id)
	)) {
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
