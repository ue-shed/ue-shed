import type { TextLocation } from "./schema.js";
import type { GameTextRuleDocument, TextQualityRule } from "./game-text-rules.js";
import type { TextRole, TextRoleMatcher } from "./quality-schema.js";

function matchesValue(actual: string, expected: string, operator: "exact" | "prefix"): boolean {
	return operator === "exact" ? actual === expected : actual.startsWith(expected);
}

/**
 * Tests one location against one authored role condition. Matching is exact or prefix-based
 * according to the matcher; role assignment remains policy and does not alter saved provenance.
 */
export function matchesTextRoleMatcher(location: TextLocation, matcher: TextRoleMatcher): boolean {
	switch (matcher.kind) {
		case "location_kind":
			return location.kind === matcher.value;
		case "object_path":
			return matchesValue(location.objectPath, matcher.value, matcher.operator);
		case "row":
			return (
				location.kind === "data_table_cell" &&
				matchesValue(location.row, matcher.value, matcher.operator)
			);
		case "property_path":
			return (
				location.kind !== "string_table_entry" &&
				matchesValue(location.propertyPath, matcher.value, matcher.operator)
			);
		case "string_table_entry":
			return (
				location.kind === "string_table_entry" &&
				matchesValue(location.entryKey, matcher.value, matcher.operator)
			);
		case "class_path":
			return (
				location.kind === "asset_property" &&
				matchesValue(location.classPath, matcher.value, matcher.operator)
			);
	}
}

/**
 * Whether an occurrence belongs to a role: any scope whose matchers all match its location. Only
 * the place's own location is read. Its folded copies (`TextOccurrence.copies`) never match by
 * their own paths: a role selects authored sites, whose text is the line's text.
 */
export function matchesTextRole(
	occurrence: { readonly location: TextLocation },
	role: TextRole
): boolean {
	return role.scopes.some((scope) =>
		scope.matchers.every((matcher) => matchesTextRoleMatcher(occurrence.location, matcher))
	);
}

type TerminologyRule = Extract<TextQualityRule, { readonly kind: "terminology" }>;
function prepareTerminology(rule: TerminologyRule) {
	const entries = [...rule.terms].sort((left, right) => {
		const leftKey = left.kind === "forbidden" ? `0:${left.term}` : `1:${left.term}`;
		const rightKey = right.kind === "forbidden" ? `0:${right.term}` : `1:${right.term}`;
		return leftKey.localeCompare(rightKey);
	});
	return entries.flatMap((entry) => {
		const discouraged =
			entry.kind === "forbidden" ? [entry.term] : [...entry.alternatives].sort();
		return discouraged.map((term) => ({
			entry,
			term
		}));
	});
}

/** A rule with its role and, for terminology, its prepared terms. */
export interface PreparedTextQualityRule {
	readonly rule: TextQualityRule;
	readonly role: TextRole;
	readonly terms: ReturnType<typeof prepareTerminology>;
}

/**
 * The file's source rules that run, in report order (by ID), each with its role; a rule without
 * one drops.
 */
export function prepareTextQualityRules(
	document: Pick<GameTextRuleDocument, "roles" | "rules">
): readonly PreparedTextQualityRule[] {
	const roleById = new Map(document.roles.map((role) => [role.id, role]));
	return document.rules
		.filter(
			(entry): entry is TextQualityRule =>
				(entry.kind === "character_budget" || entry.kind === "terminology") &&
				entry.enabled !== false
		)
		.sort((left, right) => left.id.localeCompare(right.id))
		.flatMap((rule) => {
			const role = roleById.get(rule.role);
			if (role === undefined) return [];
			const terms = rule.kind === "terminology" ? prepareTerminology(rule) : [];
			return [{ rule, role, terms }];
		});
}
