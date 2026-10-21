import type { LocalizationCultureMark } from "./localization-schema.js";
import type { TextProblemRule } from "./text-problem-rules.js";
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
import {
	TEXT_FINDING_SIGNALS,
	TEXT_PROBLEMS,
	TEXT_PROBLEM_LABELS,
	TEXT_PROBLEM_RULES
} from "./text-problem-rules.js";

export { TEXT_PROBLEM_LABELS };

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
	/**
	 * The asset types (`TextAssetType`) of the packages holding the text's saved places. Absent or
	 * empty matches no `asset_type`, so `is_not` keeps it.
	 */
	readonly assetTypes?: readonly string[];
}

/** Whether a line has work before it ships: its worst problem is one `TEXT_PROBLEM_RULES` marks. */
export function needsWork(problems: readonly TextProblem[]): boolean {
	const worst = problems[0];
	return worst !== undefined && TEXT_PROBLEM_RULES[worst].work;
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

/** A review signal a request can count as a finding. */
export type TextCountedFinding = (typeof TEXT_FINDING_SIGNALS)[number];
const nameable = new Set<TextReviewSignal>(TEXT_FINDING_SIGNALS);

/**
 * The review signals that make a line a finding under a request, as the engine counts them: the
 * default findings, and every finding the filter's `finding is` clauses or the lens name.
 */
export function countedFindings(request: {
	readonly filter?: TextFilter | undefined;
	readonly lens?: string | undefined;
}): readonly TextCountedFinding[] {
	const named = new Set<string>(TEXT_PROBLEM_RULES.finding.signals);
	for (const clause of request.filter ?? [])
		if (clause.field === "finding" && clause.op === "is")
			for (const value of clause.values) named.add(value);
	if (request.lens !== undefined) named.add(request.lens);
	return TEXT_FINDING_SIGNALS.filter((signal) => named.has(signal));
}

/** The review signals of `signals` that count as findings: `countedFindings`, or the defaults. */
export function textCountedFindings(
	signals: readonly TextReviewSignal[],
	counted: readonly TextReviewSignal[] = TEXT_PROBLEM_RULES.finding.signals
): readonly TextCountedFinding[] {
	return TEXT_FINDING_SIGNALS.filter(
		(signal) => nameable.has(signal) && counted.includes(signal) && signals.includes(signal)
	);
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
 * Every problem a line has, worst first; `up_to_date` alone when it has none, from
 * `TEXT_PROBLEM_RULES`. `marks` are the cultures in scope, absent for text that no localization
 * target covers. `countedFindings` are the signals that make a finding under the request
 * (`countedFindings`); absent, the defaults.
 */
export function textProblems(input: {
	readonly signals: readonly TextReviewSignal[];
	readonly keyChanged: boolean;
	readonly marks?: readonly LocalizationCultureMark[];
	readonly countedFindings?: readonly TextReviewSignal[];
}): readonly TextProblem[] {
	const marks = input.marks ?? [];
	const found = new Set<TextProblem>();
	if (input.keyChanged) found.add("key_changed");
	for (const problem of TEXT_PROBLEMS) {
		const rule: TextProblemRule = TEXT_PROBLEM_RULES[problem];
		const signals = problem === "finding" ? [] : rule.signals;
		if (
			signals.some((signal) => input.signals.includes(signal)) ||
			marks.some(
				(mark) =>
					rule.states.includes(mark.state) ||
					rule.facts.some((fact) => mark.facts.includes(fact)) ||
					rule.reasons.some((reason) => mark.unknownReasons.includes(reason))
			)
		)
			found.add(problem);
	}
	if (textCountedFindings(input.signals, input.countedFindings).length > 0) found.add("finding");
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
		case "asset_type":
			return clause.values.some((value) => facts.assetTypes?.includes(value) === true);
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
		unchecked: 0,
		up_to_date: 0
	} satisfies TextProblemCounts;
	for (const problems of lines) for (const problem of problems) counts[problem]++;
	return counts;
}
