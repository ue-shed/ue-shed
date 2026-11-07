import { Schema } from "effect";
import { CultureCode } from "@ue-shed/localization/browser";
import { localizationRulesOf } from "./game-text-rules.js";
const decodeCultureCode = Schema.decodeSync(CultureCode);
/**
 * The file's localization rules that run, by ID, with their roles, and the diagnostics that need
 * no lines.
 */
export function localizationPolicyRules(cultures, document) {
    const diagnostics = [];
    const rules = [];
    const roles = new Map(document.roles.map((role) => [role.id, role]));
    for (const rule of localizationRulesOf(document).sort((a, b) => a.id.localeCompare(b.id))) {
        for (const key of Object.keys(rule.cultures).sort()) {
            const culture = decodeCultureCode(key);
            if (!cultures.includes(culture))
                diagnostics.push({
                    code: "rule_culture_not_in_target",
                    severity: "warning",
                    culture,
                    ruleId: rule.id,
                    recovery: "Keep project-wide cultures when intentional, or correct the culture in this rule."
                });
        }
        const role = roles.get(rule.role);
        if (role)
            rules.push({ rule, role });
    }
    return { rules, diagnostics };
}
