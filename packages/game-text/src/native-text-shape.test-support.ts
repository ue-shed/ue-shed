import type { Schema } from "effect";
import { exampleRules } from "./rules/catalogue.js";
import { nativeEvaluateRule } from "./native-rule-reports.test-support.js";
import type { BuiltInCheckId } from "./localization-check-ids.js";

/** Explicit subject facts are inputs to the catalogue rule, never a second subject builder. */
export function evaluateCatalogueRule(
	id: BuiltInCheckId,
	facts: Readonly<Record<string, Schema.Json>>,
	params?: Readonly<Record<string, Schema.Json>>
) {
	const rule = exampleRules.find((rule) => rule.id === id);
	if (!rule) throw new Error(`No Phase 1 catalogue rule: ${id}`);
	return nativeEvaluateRule({ ...rule, params: { ...rule.params, ...params } }, facts);
}
