import { Schema } from "effect";
import {
	LocalizationReviewFile,
	CultureCode,
	LocalizationChange,
	LocalizationChangeSet,
	LocalizationIdentity,
	LocalizationTargetName
} from "@ue-shed/localization/browser";
import { LocalizationLineId, LocalizationUnknownReason } from "./localization-schema.js";
import { BuiltInCheckId, CheckSeverity } from "./localization-check-ids.js";
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
	suggestedChange: Schema.optionalKey(LocalizationChange),
	/** The check's severity; never part of the finding's ID. */
	severity: CheckSeverity,
	/**
	 * The line's distinct saved sources when they conflict (one key, several texts), sorted. The
	 * line's `source` joins them for search; findings list them instead.
	 */
	sourceVariants: Schema.optionalKey(Schema.Array(Schema.String).check(Schema.isMinLength(2)))
};
/** Source checks also cover text without a key, such as culture-invariant text. */
const SourceBase = { ...Base, identity: Schema.NullOr(LocalizationIdentity) };
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Side = Schema.Literals(["source", "translation"]);
/**
 * Built-in source/translation check finding with actual and expected evidence. Severity is
 * policy and is deliberately excluded from finding identity.
 */
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
	}),
	Schema.Struct({
		...Base,
		kind: Schema.Literal("format_argument_renamed"),
		/** `from` is the translation's name, `to` the source's, paired in order of appearance. */
		actual: Schema.Struct({
			arguments: Strings,
			renamed: Schema.Array(Schema.Struct({ from: Schema.String, to: Schema.String }))
		}),
		expectation: Schema.Struct({ arguments: Strings })
	}),
	Schema.Struct({
		...Base,
		kind: Schema.Literal("rich_text_tags"),
		actual: Schema.Struct({ tags: Strings, missing: Strings, added: Strings }),
		expectation: Schema.Struct({ tags: Strings })
	}),
	Schema.Struct({
		...Base,
		kind: Schema.Literal("rich_text_tags_added"),
		actual: Schema.Struct({ tags: Strings, added: Strings }),
		expectation: Schema.Struct({ tags: Strings })
	}),
	Schema.Struct({
		...Base,
		kind: Schema.Literal("rich_text_tag_case"),
		actual: Schema.Struct({
			changed: Schema.Array(
				Schema.Struct({ source: Schema.String, translation: Schema.String })
			)
		}),
		expectation: Schema.Struct({ sameCase: Schema.Literal(true) })
	}),
	Schema.Struct({
		...Base,
		kind: Schema.Literal("line_breaks"),
		actual: Schema.Struct({ lineBreaks: Count }),
		expectation: Schema.Struct({ lineBreaks: Count })
	}),
	Schema.Struct({
		...Base,
		kind: Schema.Literal("segment_separator"),
		actual: Schema.Struct({ separator: Schema.String, count: Count }),
		expectation: Schema.Struct({ separator: Schema.String, count: Count })
	}),
	Schema.Struct({
		...Base,
		kind: Schema.Literal("length_outlier"),
		actual: Schema.Struct({ length: Count, ratio: Schema.Number }),
		expectation: Schema.Struct({
			sourceLength: Count,
			minimumRatio: Schema.Number,
			maximumRatio: Schema.Number
		})
	}),
	Schema.Struct({
		...Base,
		kind: Schema.Literal("outdated_translation"),
		actual: Schema.Struct({ translatedSource: Schema.String }),
		expectation: Schema.Struct({ source: Schema.String })
	}),
	Schema.Struct({
		...Base,
		kind: Schema.Literal("source_line_endings_changed"),
		actual: Schema.Struct({ translatedSource: Schema.String }),
		expectation: Schema.Struct({ source: Schema.String })
	}),
	Schema.Struct({
		...Base,
		kind: Schema.Literal("placeholder_translation"),
		actual: Schema.Struct({ translation: Schema.String }),
		expectation: Schema.Struct({ translatedText: Schema.Literal(true) })
	}),
	Schema.Struct({
		...Base,
		kind: Schema.Literal("inconsistent_translation"),
		actual: Schema.Struct({
			translation: Schema.String,
			/**
			 * The most used translations of this source in the culture, at most five. Lines whose
			 * translations differ only in case, whitespace or punctuation count as one, shown in
			 * one of their spellings.
			 */
			variants: Schema.Array(
				Schema.Struct({ translation: Schema.String, lines: Count })
			).check(Schema.isMaxLength(5)),
			variantCount: Count,
			/** This line ships its source text, where other lines translate it. */
			untranslated: Schema.optionalKey(Schema.Literal(true))
		}),
		expectation: Schema.Struct({ consistentTranslation: Schema.Literal(true) })
	}),
	Schema.Struct({
		...SourceBase,
		kind: Schema.Literal("culture_invariant_text"),
		actual: Schema.Struct({ source: Schema.String }),
		expectation: Schema.Struct({ localizable: Schema.Literal(true) })
	}),
	Schema.Struct({
		...SourceBase,
		kind: Schema.Literal("placeholder_text"),
		actual: Schema.Struct({ source: Schema.String, matches: Strings }),
		expectation: Schema.Struct({ finalText: Schema.Literal(true) }),
		/**
		 * Present when the rule file's source terminology also reports some of `actual.matches`
		 * (a discouraged term overlapping the placeholder in this text, at a place of the term's
		 * role): the matches it does not report, in order, empty when it reports them all. A
		 * list that shows the rule file's source findings beside this one names only these, and
		 * leaves the finding out when none are left. Not part of the finding's ID.
		 */
		unreportedMatches: Schema.optionalKey(Strings)
	}),
	Schema.Struct({
		...SourceBase,
		kind: Schema.Literal("source_whitespace"),
		actual: Schema.Struct({
			source: Schema.String,
			leading: Schema.String,
			trailing: Schema.String,
			repeatedSpaces: Count
		}),
		expectation: Schema.Struct({ trimmed: Schema.Literal(true) })
	}),
	Schema.Struct({
		...SourceBase,
		kind: Schema.Literal("source_markup"),
		actual: Schema.Struct({
			source: Schema.String,
			richText: UnrealRichTextCounts,
			braces: Schema.Struct({ opening: Count, closing: Count }),
			/** XML-style closings such as `</Name>`, which Slate shows as text. */
			xmlClosings: Schema.optionalKey(Strings)
		}),
		expectation: Schema.Struct({ balanced: Schema.Literal(true) })
	}),
	Schema.Struct({
		...SourceBase,
		kind: Schema.Literal("number_only_text"),
		actual: Schema.Struct({ source: Schema.String }),
		expectation: Schema.Struct({ cultureInvariant: Schema.Literal(true) })
	}),
	Schema.Struct({
		...SourceBase,
		kind: Schema.Literal("string_table_key_collision"),
		actual: Schema.Struct({
			tables: Strings.check(Schema.isMaxLength(16)),
			tableCount: Count
		}),
		expectation: Schema.Struct({ oneTablePerKey: Schema.Literal(true) })
	})
]);
export type LocalizationQualityFinding = typeof LocalizationQualityFinding.Type;

const CustomMatch = Schema.Struct({ match: Schema.String, start: Count, end: Count });
/**
 * A finding of a check the rule file defines (`customChecks`). `ruleId` is the check's ID and
 * `label` its name; `check` is its kind. `actual.text` is the text checked: the source for a
 * `source` check, the culture's shipped translation for a `translation` check.
 */
export const LocalizationCustomFinding = Schema.Struct({
	...Base,
	kind: Schema.Literal("custom"),
	check: Schema.Literals(["pattern", "length", "forbidden_term"]),
	label: Schema.String,
	subject: Schema.Literals(["source", "translation"]),
	actual: Schema.Struct({
		text: Schema.String,
		length: Schema.optionalKey(Count),
		matches: Schema.optionalKey(Schema.Array(CustomMatch).check(Schema.isMaxLength(16)))
	}),
	expectation: Schema.Struct({
		pattern: Schema.optionalKey(Schema.String),
		report: Schema.optionalKey(Schema.Literals(["match", "no_match"])),
		measure: Schema.optionalKey(Schema.Literals(["visible", "characters"])),
		minimum: Schema.optionalKey(Count),
		maximum: Schema.optionalKey(Count),
		terms: Schema.optionalKey(Strings)
	})
});
export type LocalizationCustomFinding = typeof LocalizationCustomFinding.Type;

/**
 * Role-scoped character-budget or terminology finding for a translation. Its rule identity and
 * authored recovery belong to project policy rather than Unreal's parser contract.
 */
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
/**
 * Warning that a rule references a culture absent from the selected target. The rule is
 * retained for correction instead of silently being applied to another culture.
 */
export const LocalizationRuleDiagnostic = Schema.Struct({
	code: Schema.Literal("rule_culture_not_in_target"),
	severity: Schema.Literal("warning"),
	culture: CultureCode,
	ruleId: TextQualityRuleId,
	recovery: Schema.NonEmptyString
});
export type LocalizationRuleDiagnostic = typeof LocalizationRuleDiagnostic.Type;

/**
 * Optional culture/check inclusion, disabled checks and accepted-review evidence. Hosts can
 * change policy without changing the saved text reader.
 */
export const LocalizationCheckOptions = Schema.Struct({
	culture: Schema.optionalKey(CultureCode),
	checks: Schema.optionalKey(Schema.Array(BuiltInCheckId)),
	disabledChecks: Schema.optionalKey(Schema.Array(BuiltInCheckId)),
	/** Findings accepted in the target's review file are left out while their text is unchanged. */
	review: Schema.optionalKey(LocalizationReviewFile)
});
export type LocalizationCheckOptions = typeof LocalizationCheckOptions.Type;
/**
 * Line/culture evidence that limits a check, including unavailable source/translation or
 * unsupported syntax/culture. A diagnostic does not mean the check passed.
 */
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
		Schema.Union([
			TextQualityFinding,
			LocalizationQualityFinding,
			LocalizationPolicyFinding,
			LocalizationCustomFinding
		])
	),
	/** The rule file's custom checks, by rule ID, with the label lists and filters show. */
	customChecks: Schema.optionalKey(
		Schema.Array(Schema.Struct({ ruleId: TextQualityRuleId, label: Schema.String }))
	),
	ruleDocumentVersion: Schema.Literals([1, 2, 3]),
	ruleDiagnostics: Schema.optionalKey(Schema.Array(LocalizationRuleDiagnostic)),
	target: LocalizationTargetName,
	gatherEvidence: Schema.Array(LocalizationFileStatus),
	checkDiagnostics: Schema.Array(LocalizationCheckDiagnostic),
	changes: LocalizationChangeSet,
	acceptedFindings: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)))
}));
export type LocalizationQualityReport = typeof LocalizationQualityReport.Type;
