import { exampleRules } from "./rules/catalogue.js";
import { nativeEvaluateRule } from "./native-rule-reports.test-support.js";
/** Explicit subject facts are inputs to the catalogue rule, never a second subject builder. */
export function evaluateCatalogueRule(id, facts, params) {
    const rule = exampleRules.find((rule) => rule.id === id);
    if (!rule)
        throw new Error(`No Phase 1 catalogue rule: ${id}`);
    return nativeEvaluateRule({ ...rule, params: { ...rule.params, ...params } }, facts);
}
