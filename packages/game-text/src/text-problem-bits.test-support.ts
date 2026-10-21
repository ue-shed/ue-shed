/**
 * `TEXT_PROBLEM_RULES` as the engine's bit masks, for the columnar reference: a problem is bit
 * `TEXT_PROBLEMS` position, a state, fact or reason the bit of its vocabulary position, as the
 * joined columns store them.
 */
import { LocalizationState, LocalizationUnknownReason } from "./localization-schema.js";
import { TextReviewSignal, type TextFilter } from "./schema.js";
import { TEXT_PROBLEMS, TEXT_PROBLEM_RULES, type TextProblemRule } from "./text-problem-rules.js";
import { countedFindings } from "./text-problems.js";

const bitsOf = (values: readonly string[], vocabulary: readonly string[]) =>
	values.reduce((bits, value) => bits | (1 << vocabulary.indexOf(value)), 0);
const rules: readonly TextProblemRule[] = TEXT_PROBLEMS.map(
	(problem) => TEXT_PROBLEM_RULES[problem]
);
const masks = (field: "states" | "facts" | "reasons" | "signals", vocabulary: readonly string[]) =>
	rules.map((rule) => bitsOf(rule[field], vocabulary));
const stateMasks = masks("states", LocalizationState.literals);
const factMasks = masks("facts", LocalizationState.literals);
const reasonMasks = masks("reasons", LocalizationUnknownReason.literals);
const signalMasks = masks("signals", TextReviewSignal.literals);

export const problemBit = (problem: (typeof TEXT_PROBLEMS)[number]) =>
	1 << TEXT_PROBLEMS.indexOf(problem);
export const FINDING_BIT = problemBit("finding");
const FINDING = FINDING_BIT;
export const KEY_CHANGED_BIT = problemBit("key_changed");
export const UP_TO_DATE_BIT = problemBit("up_to_date");
/** Problems that leave a line work before it ships. */
export const WORK_PROBLEM_BITS = TEXT_PROBLEMS.reduce(
	(bits, problem, index) => (TEXT_PROBLEM_RULES[problem].work ? bits | (1 << index) : bits),
	0
);

/** The signal bits a request counts as findings. */
export const countedFindingBits = (request: {
	readonly filter?: TextFilter | undefined;
	readonly lens?: string | undefined;
}) => bitsOf(countedFindings(request), TextReviewSignal.literals);

/** The problems signal bits raise, with `counted` the signals that make a finding. */
export function signalProblemBits(signals: number, counted: number): number {
	let bits = signals & counted ? FINDING : 0;
	signalMasks.forEach((mask, index) => {
		if (signals & mask && 1 << index !== FINDING) bits |= 1 << index;
	});
	return bits;
}

/** The problems one culture's state index, fact bits and reason bits raise. */
export function cultureProblemBits(state: number, facts: number, reasons: number): number {
	let bits = 0;
	for (let index = 0; index < TEXT_PROBLEMS.length; index++)
		if (
			(1 << state) & stateMasks[index]! ||
			facts & factMasks[index]! ||
			reasons & reasonMasks[index]!
		)
			bits |= 1 << index;
	return bits;
}

/** `bits`, or up to date when it has no problem. */
export const settleProblemBits = (bits: number) => bits || UP_TO_DATE_BIT;
