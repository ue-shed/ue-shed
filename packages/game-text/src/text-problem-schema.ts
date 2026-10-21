import { Schema } from "effect";
import { TEXT_FINDING_SIGNALS, TEXT_PROBLEMS } from "./text-problem-rules.js";

/** A row's problems under a request, worst first: what groups and filters it by problem. */
export const TextRowProblems = Schema.Array(Schema.Literals(TEXT_PROBLEMS)).check(
	Schema.isMinLength(1),
	Schema.isMaxLength(TEXT_PROBLEMS.length)
);
export type TextRowProblems = typeof TextRowProblems.Type;

/**
 * The review signals that made a row a finding under a request: the default findings and any the
 * request named, that the row has. Show these on the row; other signals did not count.
 */
export const TextCountedFindings = Schema.Array(Schema.Literals(TEXT_FINDING_SIGNALS)).check(
	Schema.isMaxLength(TEXT_FINDING_SIGNALS.length)
);
export type TextCountedFindings = typeof TextCountedFindings.Type;
