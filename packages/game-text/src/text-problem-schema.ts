import { Schema } from "effect";
import { TEXT_PROBLEMS } from "./text-problem-rules.js";

/** A row's problems under a request, worst first: what groups and filters it by problem. */
export const TextRowProblems = Schema.Array(Schema.Literals(TEXT_PROBLEMS)).check(
	Schema.isMinLength(1),
	Schema.isMaxLength(TEXT_PROBLEMS.length)
);
export type TextRowProblems = typeof TextRowProblems.Type;

/** A rule as a findings layer names it: a built-in check's name, or a project rule's `id`. */
export const TextRuleId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
export type TextRuleId = typeof TextRuleId.Type;

/** The most rule IDs one row lists; `findingsOmitted` counts the rest. */
export const MAX_TEXT_ROW_FINDINGS = 32;

/** The rules with a finding on a row, in the layer's program order. */
export const TextRowFindings = Schema.Array(TextRuleId).check(
	Schema.isMaxLength(MAX_TEXT_ROW_FINDINGS)
);
export type TextRowFindings = typeof TextRowFindings.Type;

/** A row's findings, when the read names a findings layer. */
export const textRowFindingFields = {
	findings: Schema.optionalKey(TextRowFindings),
	findingsOmitted: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)))
};

/**
 * The findings layer a read shows: its key, the review acceptance whose findings it hides, and
 * whether it shows only the source rules, as Browse does without a target. Workspaces set it.
 */
export const TextFindingsSelection = Schema.Struct({
	key: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
	acceptance: Schema.optionalKey(
		Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))
	),
	sourceOnly: Schema.optionalKey(Schema.Boolean)
});
export type TextFindingsSelection = typeof TextFindingsSelection.Type;

/**
 * Whether a page's finding fields are filled: `none` without an enabled rule, `pending` while
 * the rules evaluate, `ready` once the page reads their findings.
 */
export const TextFindingsStatus = Schema.Struct({
	status: Schema.Literals(["none", "pending", "ready"])
});
export type TextFindingsStatus = typeof TextFindingsStatus.Type;

/**
 * Review signals that once made a row a finding.
 * @deprecated Rows list their rules' findings in `findings`; nothing sets `countedFindings`.
 */
export const TextCountedFindings = Schema.Array(
	Schema.Literals([
		"shared",
		"duplicate_source",
		"long",
		"unresolved",
		"evidence_only",
		"compiled_copy_differs"
	])
).check(Schema.isMaxLength(6));
/** @deprecated See `TextCountedFindings`. */
export type TextCountedFindings = typeof TextCountedFindings.Type;
