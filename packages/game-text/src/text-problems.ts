import type { LocalizationCultureMark } from "./localization-schema.js";
import {
	TextProblem,
	type TextAudience,
	type TextEditing,
	type TextFilter,
	type TextFilterClause,
	type TextFilterField,
	type TextFinding,
	type TextNotes,
	type TextOriginKind,
	type TextProblemCounts,
	type TextReviewSignal,
	type TextTranslationState
} from "./schema.js";
import { matchesTextPathPrefix, textFileKey } from "./text-origin.js";

/** What a filter can ask about one line or text unit. */
export interface TextFacts {
	readonly problems: readonly TextProblem[];
	readonly findings: readonly TextFinding[];
	readonly translation: readonly TextTranslationState[];
	readonly origins: readonly TextOriginKind[];
	/** Normalized object paths, package files and gathered source paths. */
	readonly paths: readonly string[];
	/** Files holding the text, spelled for showing (`textFileLabel`): assets and source files. */
	readonly files: readonly string[];
	readonly namespace: string | undefined;
	readonly editing: readonly TextEditing[];
	readonly notes: TextNotes;
	/** Player if any saved place is player text, else unknown if any is, else editor. */
	readonly audience: TextAudience;
	/**
	 * The translation keys (`gatheredIdentityKey`) the text is gathered under: a line's own, or
	 * every key a unit's occurrences gather to. Absent or empty matches no `translation_key`.
	 */
	readonly translationKeys?: readonly string[];
	/**
	 * Every review signal, which `finding` clauses read when present; `findings` otherwise. Absent
	 * signals leave `finding` to the actionable subset.
	 */
	readonly reviewSignals?: readonly TextReviewSignal[];
	/**
	 * The exact source texts: a line's source, or a unit's sources in UTF-16 order. Absent matches
	 * no `source` clause and groups under the empty text.
	 */
	readonly sources?: readonly string[];
}

/**
 * Display labels for stable text-problem categories. Hosts may present different wording
 * without changing stored problem codes or the policy that reports them.
 */
export const TEXT_PROBLEM_LABELS = {
	key_changed: "Key changed",
	conflicting_source: "Same key, different text",
	not_gathered: "Not gathered yet",
	changed_since_gather: "Changed since gather",
	translation: "Translation work",
	finding: "Findings",
	up_to_date: "Up to date"
} satisfies Record<TextProblem, string>;

/** Whether a line has work before it ships: any problem worse than a finding. */
export function needsWork(problems: readonly TextProblem[]): boolean {
	const worst = problems[0];
	return worst !== undefined && worst !== "finding" && worst !== "up_to_date";
}

const findingSignals = new Set<TextReviewSignal>([
	"shared",
	"duplicate_source",
	"long",
	"unresolved"
]);

function isFinding(signal: TextReviewSignal): signal is TextFinding {
	return findingSignals.has(signal);
}

/** Translation work in the given cultures' marks. */
export function translationStates(
	marks: readonly LocalizationCultureMark[]
): readonly TextTranslationState[] {
	const states = new Set<TextTranslationState>();
	for (const mark of marks) {
		if (mark.state === "not_translated") states.add("missing");
		if (mark.state === "needs_update") states.add("to_update");
		if (mark.state === "not_synced" || mark.facts.includes("not_synced"))
			states.add("not_synced");
	}
	return [...states];
}

/**
 * Every problem a line has, worst first; `up_to_date` alone when it has none. `marks` are the
 * cultures in scope, absent for text that no localization target covers.
 */
export function textProblems(input: {
	readonly signals: readonly TextReviewSignal[];
	readonly keyChanged: boolean;
	readonly marks?: readonly LocalizationCultureMark[];
}): readonly TextProblem[] {
	const marks = input.marks ?? [];
	const found = new Set<TextProblem>();
	if (input.keyChanged) found.add("key_changed");
	if (
		input.signals.includes("conflicting") ||
		marks.some((mark) => mark.unknownReasons.includes("conflicting_source"))
	)
		found.add("conflicting_source");
	if (marks.some((mark) => mark.state === "not_gathered")) found.add("not_gathered");
	if (marks.some((mark) => mark.state === "changed_since_gather"))
		found.add("changed_since_gather");
	if (translationStates(marks).length > 0) found.add("translation");
	if (input.signals.some(isFinding)) found.add("finding");
	if (found.size === 0) return ["up_to_date"];
	return TextProblem.literals.filter((problem) => found.has(problem));
}

/**
 * Keeps the actionable TextFinding subset of review signals. Conflicting, evidence-only and
 * compiled-copy signals remain available separately and are not converted into this subset.
 */
export function textFindings(signals: readonly TextReviewSignal[]): readonly TextFinding[] {
	return signals.filter(isFinding);
}

function clauseHas(facts: TextFacts, clause: TextFilterClause): boolean {
	switch (clause.field) {
		case "problem":
			return clause.values.some((value) => facts.problems.includes(value));
		case "finding": {
			const signals: readonly string[] = facts.reviewSignals ?? facts.findings;
			return clause.values.some((value) => signals.includes(value));
		}
		case "translation":
			return clause.values.some((value) => facts.translation.includes(value));
		case "origin":
			return clause.values.some((value) => facts.origins.includes(value));
		case "folder":
			return clause.values.some((value) => matchesTextPathPrefix(facts.paths, value));
		case "asset": {
			const keys = facts.files.map(textFileKey);
			return clause.values.some((value) => keys.includes(textFileKey(value)));
		}
		case "namespace":
			return facts.namespace !== undefined && clause.values.includes(facts.namespace);
		case "editing":
			return clause.values.some((value) => facts.editing.includes(value));
		case "notes":
			return clause.values.includes(facts.notes);
		case "audience":
			return clause.values.includes(facts.audience);
		case "translation_key":
			return clause.values.some((value) => facts.translationKeys?.includes(value) === true);
		case "source":
			return clause.values.some((value) => facts.sources?.includes(value) === true);
	}
}

/** Whether every clause matches, leaving out clauses on `except` so a facet can count itself. */
export function matchesTextFilter(
	facts: TextFacts,
	filter: TextFilter | undefined,
	except?: TextFilterField
): boolean {
	if (filter === undefined) return true;
	return filter.every(
		(clause) => clause.field === except || clauseHas(facts, clause) === (clause.op === "is")
	);
}

/** How many lines have each problem; a line counts once for every problem it has. */
export function textProblemCounts(lines: Iterable<readonly TextProblem[]>): TextProblemCounts {
	const counts = {
		key_changed: 0,
		conflicting_source: 0,
		not_gathered: 0,
		changed_since_gather: 0,
		translation: 0,
		finding: 0,
		up_to_date: 0
	} satisfies TextProblemCounts;
	for (const problems of lines) for (const problem of problems) counts[problem]++;
	return counts;
}
