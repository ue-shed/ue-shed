import { Schema } from "effect";
import {
	CultureCode,
	LocalizationChange,
	LocalizationChangeSet,
	LocalizationIdentity,
	LocalizationTargetName
} from "@ue-shed/localization/browser";
import { LocalizationLineId, LocalizationUnknownReason } from "./localization-schema.js";
import { LocalizationCheckId } from "./localization-check-ids.js";
import {
	TextQualityAffectedOccurrence,
	TextQualityFinding,
	TextQualityReport,
	TextRoleId,
	CharacterBudgetActual,
	CharacterBudgetExpectation,
	TerminologyActual,
	TerminologyExpectation,
	TextQualityRuleId
} from "./quality-schema.js";
import { LocalizationFileStatus } from "./localization-status.js";
import {
	UnrealFormatIssue,
	UnrealModifierIdentity,
	UnrealRichTextCounts,
	UnrealWhitespace
} from "./unreal-text-syntax.js";

const Strings = Schema.Array(Schema.String);
const Base = {
	lineId: LocalizationLineId,
	target: LocalizationTargetName,
	culture: CultureCode,
	identity: LocalizationIdentity,
	ruleId: TextQualityRuleId,
	recovery: Schema.NonEmptyString,
	affectedOccurrences: Schema.Array(TextQualityAffectedOccurrence),
	manifestLocations: Strings,
	translationOrigin: Schema.Literals(["po", "archive", "absent"]),
	suggestedChange: Schema.optionalKey(LocalizationChange)
};
const Side = Schema.Literals(["source", "translation"]);
export const LocalizationQualityFinding = Schema.Union([
	Schema.Struct({
		...Base,
		kind: Schema.Literal("format_arguments"),
		actual: Schema.Struct({ arguments: Strings, missing: Strings, added: Strings }),
		expectation: Schema.Struct({ arguments: Strings })
	}),
	Schema.Struct({
		...Base,
		kind: Schema.Literal("argument_modifiers"),
		actual: Schema.Struct({
			side: Side,
			issues: Schema.Array(UnrealFormatIssue),
			modifiers: Schema.Array(UnrealModifierIdentity)
		}),
		expectation: Schema.Struct({ modifiers: Schema.Array(UnrealModifierIdentity) })
	}),
	Schema.Struct({
		...Base,
		kind: Schema.Literal("rich_text"),
		actual: UnrealRichTextCounts,
		expectation: UnrealRichTextCounts
	}),
	Schema.Struct({
		...Base,
		kind: Schema.Literal("po_escape_safety"),
		actual: Schema.Struct({ positions: Schema.Array(Schema.Int), sequences: Strings }),
		expectation: Schema.Struct({ roundTripSafe: Schema.Literal(true) })
	}),
	Schema.Struct({
		...Base,
		kind: Schema.Literal("whitespace"),
		actual: UnrealWhitespace,
		expectation: UnrealWhitespace
	}),
	Schema.Struct({
		...Base,
		kind: Schema.Literal("empty_translation"),
		actual: Schema.Struct({
			entryExists: Schema.Literal(true),
			translation: Schema.Literal("")
		}),
		expectation: Schema.Struct({ nonEmptyTranslation: Schema.Literal(true) })
	}),
	Schema.Struct({
		...Base,
		kind: Schema.Literal("missing_translator_notes"),
		actual: Schema.Struct({ noteCount: Schema.Literal(0) }),
		expectation: Schema.Struct({ minimumNotes: Schema.Literal(1) })
	}),
	Schema.Struct({
		...Base,
		kind: Schema.Literal("duplicate_source"),
		actual: Schema.Struct({
			source: Schema.String,
			identityCount: Schema.Int,
			identities: Schema.Array(LocalizationIdentity).check(Schema.isMaxLength(5))
		}),
		expectation: Schema.Struct({ reviewDistinctKeys: Schema.Literal(true) })
	})
]);
export type LocalizationQualityFinding = typeof LocalizationQualityFinding.Type;

export const LocalizationPolicyFinding = Schema.Union([
	Schema.Struct({
		...Base,
		role: TextRoleId,
		kind: Schema.Literal("localization_character_budget"),
		actual: CharacterBudgetActual.mapFields(({ source, ...fields }) => ({
			...fields,
			translation: source
		})),
		expectation: CharacterBudgetExpectation
	}),
	Schema.Struct({
		...Base,
		role: TextRoleId,
		kind: Schema.Literal("localization_terminology"),
		actual: TerminologyActual.mapFields(({ source, ...fields }) => ({
			...fields,
			translation: source
		})),
		expectation: TerminologyExpectation
	})
]);
export type LocalizationPolicyFinding = typeof LocalizationPolicyFinding.Type;
export const LocalizationRuleDiagnostic = Schema.Struct({
	code: Schema.Literal("rule_culture_not_in_target"),
	severity: Schema.Literal("warning"),
	culture: CultureCode,
	ruleId: TextQualityRuleId,
	recovery: Schema.NonEmptyString
});
export type LocalizationRuleDiagnostic = typeof LocalizationRuleDiagnostic.Type;

export const LocalizationCheckOptions = Schema.Struct({
	culture: Schema.optionalKey(CultureCode),
	checks: Schema.optionalKey(Schema.Array(LocalizationCheckId)),
	disabledChecks: Schema.optionalKey(Schema.Array(LocalizationCheckId))
});
export type LocalizationCheckOptions = typeof LocalizationCheckOptions.Type;
export const LocalizationCheckDiagnostic = Schema.Struct({
	lineId: LocalizationLineId,
	culture: CultureCode,
	code: Schema.Union([
		LocalizationUnknownReason,
		Schema.Literals([
			"source_unavailable",
			"translation_unavailable",
			"unsupported_culture",
			"syntax_limit",
			"reduced_source_checking"
		])
	])
});
export type LocalizationCheckDiagnostic = typeof LocalizationCheckDiagnostic.Type;

/** Additive report variant: legacy source-quality consumers keep their existing finding contract. */
export const LocalizationQualityReport = TextQualityReport.mapFields((fields) => ({
	...fields,
	findings: Schema.Array(
		Schema.Union([TextQualityFinding, LocalizationQualityFinding, LocalizationPolicyFinding])
	),
	ruleDocumentVersion: Schema.Literals([1, 2]),
	ruleDiagnostics: Schema.optionalKey(Schema.Array(LocalizationRuleDiagnostic)),
	target: LocalizationTargetName,
	gatherEvidence: Schema.Array(LocalizationFileStatus),
	checkDiagnostics: Schema.Array(LocalizationCheckDiagnostic),
	changes: LocalizationChangeSet
}));
export type LocalizationQualityReport = typeof LocalizationQualityReport.Type;
