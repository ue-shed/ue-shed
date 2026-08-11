import type { TextCorpus, TextLocation, TextOccurrence, TextUnit } from "./schema.js";
import type {
	TextQualityAffectedOccurrence,
	TextQualityFinding,
	TextQualityReport,
	TextQualityRule,
	TextQualityRuleDocument,
	TextRole,
	TextRoleMatcher
} from "./quality-schema.js";

function matchesValue(actual: string, expected: string, operator: "exact" | "prefix"): boolean {
	return operator === "exact" ? actual === expected : actual.startsWith(expected);
}

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

export function matchesTextRole(occurrence: TextOccurrence, role: TextRole): boolean {
	return role.scopes.some((scope) =>
		scope.matchers.every((matcher) => matchesTextRoleMatcher(occurrence.location, matcher))
	);
}

function affectedOccurrence(occurrence: TextOccurrence): TextQualityAffectedOccurrence {
	return {
		id: occurrence.id,
		location: occurrence.location,
		packageFile: occurrence.packageFile
	};
}

function occurrenceGroups(
	unit: TextUnit,
	role: TextRole
): ReadonlyArray<{
	readonly occurrences: readonly TextOccurrence[];
	readonly source: string;
}> {
	const groups = new Map<string, TextOccurrence[]>();
	for (const occurrence of unit.occurrences) {
		if (!matchesTextRole(occurrence, role)) continue;
		groups.set(occurrence.source, [...(groups.get(occurrence.source) ?? []), occurrence]);
	}
	return [...groups]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([source, occurrences]) => ({
			occurrences: [...occurrences].sort((left, right) => left.id.localeCompare(right.id)),
			source
		}));
}

function characterBudgetFindings(options: {
	readonly role: TextRole;
	readonly rule: Extract<TextQualityRule, { readonly kind: "character_budget" }>;
	readonly unit: TextUnit;
}): readonly TextQualityFinding[] {
	return occurrenceGroups(options.unit, options.role).flatMap(({ occurrences, source }) =>
		source.length > options.rule.maximumCharacters
			? [
					{
						actual: { characterCount: source.length, kind: "character_count", source },
						affectedOccurrences: occurrences.map(affectedOccurrence),
						expectation: {
							kind: "maximum_characters",
							maximumCharacters: options.rule.maximumCharacters
						},
						kind: "character_budget" as const,
						recovery: options.rule.recovery,
						role: options.role.id,
						ruleId: options.rule.id,
						textUnitId: options.unit.id
					}
				]
			: []
	);
}

function escapedRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function termMatches(
	source: string,
	term: string,
	caseSensitive: boolean
): ReadonlyArray<{ readonly end: number; readonly matched: string; readonly start: number }> {
	const expression = new RegExp(escapedRegExp(term), caseSensitive ? "gu" : "giu");
	return [...source.matchAll(expression)].map((match) => ({
		end: (match.index ?? 0) + match[0].length,
		matched: match[0],
		start: match.index ?? 0
	}));
}

function terminologyFindings(options: {
	readonly role: TextRole;
	readonly rule: Extract<TextQualityRule, { readonly kind: "terminology" }>;
	readonly unit: TextUnit;
}): readonly TextQualityFinding[] {
	const entries = [...options.rule.terms].sort((left, right) => {
		const leftKey = left.kind === "forbidden" ? `0:${left.term}` : `1:${left.term}`;
		const rightKey = right.kind === "forbidden" ? `0:${right.term}` : `1:${right.term}`;
		return leftKey.localeCompare(rightKey);
	});
	return occurrenceGroups(options.unit, options.role).flatMap(({ occurrences, source }) =>
		entries.flatMap((entry): readonly TextQualityFinding[] => {
			const discouraged =
				entry.kind === "forbidden" ? [entry.term] : [...entry.alternatives].sort();
			return discouraged.flatMap((term) =>
				termMatches(source, term, options.rule.caseSensitive).map((match) => ({
					actual: {
						end: match.end,
						kind: "terminology_match" as const,
						source,
						start: match.start,
						term: match.matched
					},
					affectedOccurrences: occurrences.map(affectedOccurrence),
					expectation:
						entry.kind === "forbidden"
							? { kind: "forbidden_term" as const, term: entry.term }
							: {
									discouragedTerm: term,
									kind: "preferred_term" as const,
									preferredTerm: entry.term
								},
					kind: "terminology" as const,
					recovery: options.rule.recovery,
					role: options.role.id,
					ruleId: options.rule.id,
					textUnitId: options.unit.id
				}))
			);
		})
	);
}

function findingsForRule(options: {
	readonly role: TextRole;
	readonly rule: TextQualityRule;
	readonly units: readonly TextUnit[];
}): readonly TextQualityFinding[] {
	return options.units.flatMap((unit) =>
		options.rule.kind === "character_budget"
			? characterBudgetFindings({ role: options.role, rule: options.rule, unit })
			: terminologyFindings({ role: options.role, rule: options.rule, unit })
	);
}

/** Pure quality evaluation over an already-built TextCorpus. */
export function evaluateTextQuality(
	corpus: TextCorpus,
	document: TextQualityRuleDocument
): TextQualityReport {
	const units = [...corpus.units].sort((left, right) => left.id.localeCompare(right.id));
	const roles = [...document.roles].sort((left, right) => left.id.localeCompare(right.id));
	const roleById = new Map(roles.map((role) => [role.id, role]));
	const rules = [...document.rules].sort((left, right) => left.id.localeCompare(right.id));
	const findings = rules.flatMap((rule) => {
		const role = roleById.get(rule.role);
		if (role === undefined) return [];
		return findingsForRule({ role, rule, units });
	});

	return {
		coverage: corpus.coverage,
		diagnostics: corpus.diagnostics,
		findings,
		roles: roles.map((role) => {
			const matchedUnits = units.filter((unit) =>
				unit.occurrences.some((occurrence) => matchesTextRole(occurrence, role))
			);
			return {
				matchedOccurrences: matchedUnits.reduce(
					(count, unit) =>
						count +
						unit.occurrences.filter((occurrence) => matchesTextRole(occurrence, role))
							.length,
					0
				),
				matchedTextUnits: matchedUnits.length,
				role: role.id
			};
		}),
		ruleDocumentVersion: document.schemaVersion,
		rules: rules.map((rule) => ({
			findingCount: findings.filter((finding) => finding.ruleId === rule.id).length,
			ruleId: rule.id
		})),
		schemaVersion: 1,
		status: corpus.status
	};
}
