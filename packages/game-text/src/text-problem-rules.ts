/**
 * The one definition of which localization states, facts and unknown reasons put a line under
 * which problem. `textProblems` reads it, and
 * `scripts/generate-text-problem-rules.ts` writes it into the native engine as
 * `crates/game-text-index/src/text_problem_rules.rs`; a test fails when that file is stale. Keep
 * this module free of runtime imports so the generator can load it directly.
 */
import type { LocalizationState, LocalizationUnknownReason } from "./localization-schema.js";
import type { TextReviewSignal } from "./schema.js";

/** Every problem, worst first. The native engine numbers them by position, as bits. */
export const TEXT_PROBLEMS = [
	"key_changed",
	"conflicting_source",
	"not_gathered",
	"changed_since_gather",
	"translation",
	"finding",
	"unchecked",
	"up_to_date"
] as const;
export type TextProblemCode = (typeof TEXT_PROBLEMS)[number];

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
	unchecked: "Couldn't check",
	up_to_date: "Up to date"
} as const satisfies Record<TextProblemCode, string>;

/** What raises one problem; a line has it when any listed state, fact or reason applies. */
export interface TextProblemRule {
	/** A culture in scope has one of these primary states. */
	readonly states: readonly LocalizationState[];
	/** A culture in scope has one of these secondary facts. */
	readonly facts: readonly LocalizationState[];
	/** A culture in scope has one of these unknown reasons. */
	readonly reasons: readonly LocalizationUnknownReason[];
	/** The line or unit has one of these review facts. */
	readonly signals: readonly TextReviewSignal[];
	/** Whether a line has work before it ships when this is its worst problem. */
	readonly work: boolean;
}

const rule = (fields: Partial<TextProblemRule> & Pick<TextProblemRule, "work">) => ({
	states: [],
	facts: [],
	reasons: [],
	signals: [],
	...fields
});

/**
 * The rule for each problem. `key_changed` comes from the line's key change (the new key), not
 * the table, and `finding` from the findings of the project's rules that count, not the table.
 * `up_to_date` is what a line has when nothing else applies; `gathered_only`, `outside_target`
 * and `translated` are facts, not problems.
 */
export const TEXT_PROBLEM_RULES = {
	key_changed: rule({ work: true }),
	conflicting_source: rule({
		reasons: ["conflicting_source"],
		signals: ["conflicting"],
		work: true
	}),
	not_gathered: rule({ states: ["not_gathered"], work: true }),
	// Not found: the manifest has the key, and its fully read package no longer does.
	changed_since_gather: rule({ states: ["changed_since_gather", "not_found"], work: true }),
	translation: rule({
		states: ["not_translated", "needs_update", "not_synced"],
		facts: ["not_synced"],
		work: true
	}),
	finding: rule({ work: false }),
	// The evidence could not prove a state, such as text in a package the reader read only partly.
	unchecked: rule({ states: ["unknown"], work: false }),
	up_to_date: rule({ work: false })
} as const satisfies Record<TextProblemCode, TextProblemRule>;
