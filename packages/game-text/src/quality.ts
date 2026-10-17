import { textCorpusDiagnosticSummary } from "./corpus-summary.js";
import type { TextCorpus, TextLocation, TextOccurrence, TextUnitId } from "./schema.js";
import { hasSearchableSource } from "./search.js";
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

/** What a source rule reads of an occurrence: where it is and its text. */
export interface TextQualityOccurrence {
	readonly location: TextLocation;
	readonly source: string;
}

function affectedOccurrence(occurrence: TextOccurrence): TextQualityAffectedOccurrence {
	return {
		id: occurrence.id,
		location: occurrence.location,
		packageFile: occurrence.packageFile
	};
}

/**
 * The role's occurrences of a unit grouped by source, in source order. Each group keeps the
 * unit's occurrence order; sources equal under collation keep first-seen order.
 */
function occurrenceGroups<O extends TextQualityOccurrence>(
	occurrences: readonly O[],
	role: TextRole
): ReadonlyArray<{ readonly occurrences: readonly O[]; readonly source: string }> {
	const groups = new Map<string, O[]>();
	for (const occurrence of occurrences) {
		if (!matchesTextRole(occurrence, role)) continue;
		const group = groups.get(occurrence.source);
		if (group) group.push(occurrence);
		else groups.set(occurrence.source, [occurrence]);
	}
	return [...groups]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([source, occurrences]) => ({ occurrences, source }));
}

function escapedRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Literal terms bounded by Unicode letters, marks and numbers; punctuation inside a term stays
 * literal. Marks count as word characters so a decomposed accent or an Indic vowel sign keeps a
 * term from matching inside a word.
 */
function terminologyExpression(term: string, caseSensitive: boolean): RegExp {
	return new RegExp(
		"(?<![\\p{L}\\p{M}\\p{N}])" + escapedRegExp(term) + "(?![\\p{L}\\p{M}\\p{N}])",
		caseSensitive ? "gu" : "giu"
	);
}

/**
 * Finds literal terminology matches at Unicode letter/mark/number boundaries. Case sensitivity
 * is explicit; start/end are JavaScript UTF-16 offsets with an exclusive end.
 */
export function termMatches(
	source: string,
	term: string,
	caseSensitive: boolean
): ReadonlyArray<{ readonly end: number; readonly matched: string; readonly start: number }> {
	const expression = terminologyExpression(term, caseSensitive);
	return matchesExpression(source, expression);
}

function matchesExpression(source: string, expression: RegExp) {
	return [...source.matchAll(expression)].map((match) => ({
		end: (match.index ?? 0) + match[0].length,
		matched: match[0],
		start: match.index ?? 0
	}));
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
			term,
			asciiTerm: /^\p{ASCII}*$/u.test(term) ? term.toLowerCase() : undefined,
			expression: terminologyExpression(term, rule.caseSensitive)
		}));
	});
}

/** A rule with its role and, for terminology, its prepared terms. */
export interface PreparedTextQualityRule {
	readonly rule: TextQualityRule;
	readonly role: TextRole;
	readonly terms: ReturnType<typeof prepareTerminology>;
}

/** The document's rules in report order (by ID), each with its role; a rule without one drops. */
export function prepareTextQualityRules(
	document: Pick<TextQualityRuleDocument, "roles" | "rules">
): readonly PreparedTextQualityRule[] {
	const roleById = new Map(document.roles.map((role) => [role.id, role]));
	return [...document.rules]
		.sort((left, right) => left.id.localeCompare(right.id))
		.flatMap((rule) => {
			const role = roleById.get(rule.role);
			if (role === undefined) return [];
			const terms = rule.kind === "terminology" ? prepareTerminology(rule) : [];
			return [{ rule, role, terms }];
		});
}

/**
 * One unit's findings for one rule, in report order. `affected` turns a finding's occurrences
 * into their evidence; it runs only for occurrences that produce a finding, and the evidence is
 * then ordered by occurrence ID. The in-memory and indexed evaluations share this function.
 */
export function textQualityUnitFindings<O extends TextQualityOccurrence>(
	prepared: PreparedTextQualityRule,
	textUnitId: TextUnitId,
	occurrences: readonly O[],
	affected: (occurrences: readonly O[]) => readonly TextQualityAffectedOccurrence[]
): TextQualityFinding[] {
	const { role, rule } = prepared;
	const findings: TextQualityFinding[] = [];
	const evidence = (group: readonly O[]) =>
		[...affected(group)].sort((left, right) => left.id.localeCompare(right.id));
	for (const group of occurrenceGroups(occurrences, role)) {
		const { source } = group;
		if (rule.kind === "character_budget") {
			if (source.length <= rule.maximumCharacters) continue;
			findings.push({
				actual: { characterCount: source.length, kind: "character_count", source },
				affectedOccurrences: evidence(group.occurrences),
				expectation: {
					kind: "maximum_characters",
					maximumCharacters: rule.maximumCharacters
				},
				kind: "character_budget",
				recovery: rule.recovery,
				role: role.id,
				ruleId: rule.id,
				textUnitId
			});
			continue;
		}
		const asciiSource =
			!rule.caseSensitive && /^\p{ASCII}*$/u.test(source) ? source.toLowerCase() : undefined;
		let groupEvidence: TextQualityAffectedOccurrence[] | undefined;
		for (const { entry, term, asciiTerm, expression } of prepared.terms) {
			// A negative literal test is safe for case-sensitive terms, and for ASCII-only
			// case folding. Unicode /iu behavior and all positive match offsets stay with RegExp.
			if (
				rule.caseSensitive
					? !source.includes(term)
					: asciiSource !== undefined &&
						asciiTerm !== undefined &&
						!asciiSource.includes(asciiTerm)
			)
				continue;
			for (const match of matchesExpression(source, expression))
				findings.push({
					actual: {
						end: match.end,
						kind: "terminology_match",
						source,
						start: match.start,
						term: match.matched
					},
					affectedOccurrences: (groupEvidence ??= evidence(group.occurrences)),
					expectation:
						entry.kind === "forbidden"
							? { kind: "forbidden_term", term: entry.term }
							: {
									discouragedTerm: term,
									kind: "preferred_term",
									preferredTerm: entry.term
								},
					kind: "terminology",
					recovery: rule.recovery,
					role: role.id,
					ruleId: rule.id,
					textUnitId
				});
		}
	}
	return findings;
}

const inMemoryEvidence = (occurrences: readonly TextOccurrence[]) =>
	occurrences.map(affectedOccurrence);

/** Pure quality evaluation over an already-built TextCorpus. */
export function evaluateTextQuality(
	corpus: TextCorpus,
	document: TextQualityRuleDocument
): TextQualityReport {
	const units = corpus.units
		.filter(hasSearchableSource)
		.sort((left, right) => left.id.localeCompare(right.id));
	const roles = [...document.roles].sort((left, right) => left.id.localeCompare(right.id));
	const rules = [...document.rules].sort((left, right) => left.id.localeCompare(right.id));
	const findings = prepareTextQualityRules(document).flatMap((prepared) =>
		units.flatMap((unit) =>
			textQualityUnitFindings(prepared, unit.id, unit.occurrences, inMemoryEvidence)
		)
	);

	return {
		coverage: corpus.coverage,
		...textCorpusDiagnosticSummary(corpus.diagnostics),
		findings,
		roles: roles.map((role) => {
			let matchedOccurrences = 0,
				matchedTextUnits = 0;
			for (const unit of units) {
				let matched = 0;
				for (const occurrence of unit.occurrences)
					if (matchesTextRole(occurrence, role)) matched++;
				matchedOccurrences += matched;
				if (matched > 0) matchedTextUnits++;
			}
			return { matchedOccurrences, matchedTextUnits, role: role.id };
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
