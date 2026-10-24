import { TextCorpusDiagnosticSummary } from "./corpus-summary.js";
import { Schema } from "effect";
import { TextCorpus, TextLocation, TextOccurrenceId, TextUnitId } from "./schema.js";
import { gameTextResponseParser } from "./response-parser.js";

const SafeIdentifier = Schema.Trim.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/));
const EvidenceValue = Schema.Trim.check(Schema.isNonEmpty(), Schema.isMaxLength(1024));
const AuthoredGuidance = Schema.Trim.check(Schema.isNonEmpty(), Schema.isMaxLength(2048));
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));
const EvidenceOperator = Schema.Literals(["exact", "prefix"]);

/**
 * Validated authored role identity: a bounded trimmed identifier. Role names are policy keys
 * referenced by source and translation checks.
 */
export const TextRoleId = SafeIdentifier.pipe(Schema.brand("TextRoleId"));
export type TextRoleId = Schema.Schema.Type<typeof TextRoleId>;

/**
 * Validated authored quality-rule identity. Stable IDs connect findings, severities and review
 * decisions even when display labels change.
 */
export const TextQualityRuleId = SafeIdentifier.pipe(Schema.brand("TextQualityRuleId"));
export type TextQualityRuleId = Schema.Schema.Type<typeof TextQualityRuleId>;

/**
 * One location-evidence condition for an authored role, using a kind or exact/prefix field
 * match. It selects text places without changing parser facts.
 */
export const TextRoleMatcher = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("location_kind"),
		value: Schema.Literals(["data_table_cell", "string_table_entry", "asset_property"])
	}),
	Schema.Struct({
		kind: Schema.Literal("object_path"),
		operator: EvidenceOperator,
		value: EvidenceValue
	}),
	Schema.Struct({
		kind: Schema.Literal("row"),
		operator: EvidenceOperator,
		value: EvidenceValue
	}),
	Schema.Struct({
		kind: Schema.Literal("property_path"),
		operator: EvidenceOperator,
		value: EvidenceValue
	}),
	Schema.Struct({
		kind: Schema.Literal("string_table_entry"),
		operator: EvidenceOperator,
		value: EvidenceValue
	}),
	Schema.Struct({
		kind: Schema.Literal("class_path"),
		operator: EvidenceOperator,
		value: EvidenceValue
	})
]);
export type TextRoleMatcher = Schema.Schema.Type<typeof TextRoleMatcher>;

/**
 * Role matching conditions over saved locations. Scope is authored policy and can be changed
 * without changing Unreal extraction.
 */
export const TextRoleScope = Schema.Struct({
	matchers: Schema.Array(TextRoleMatcher).check(Schema.isMinLength(1), Schema.isMaxLength(16))
});
export type TextRoleScope = Schema.Schema.Type<typeof TextRoleScope>;

/**
 * Named authored role with a matching scope. Rules refer to its ID; hosts must validate
 * references before applying a document.
 */
export const TextRole = Schema.Struct({
	id: TextRoleId,
	description: Schema.optionalKey(AuthoredGuidance),
	scopes: Schema.Array(TextRoleScope).check(Schema.isMinLength(1), Schema.isMaxLength(64))
});
export type TextRole = Schema.Schema.Type<typeof TextRole>;

/**
 * Forbidden or discouraged/preferred term policy. Matching uses the configured spelling and
 * case behavior; it does not rewrite source text automatically.
 */
export const TextTerminologyEntry = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("forbidden"), term: EvidenceValue }),
	Schema.Struct({
		kind: Schema.Literal("preferred"),
		alternatives: Schema.Array(EvidenceValue).check(
			Schema.isMinLength(1),
			Schema.isMaxLength(64)
		),
		term: EvidenceValue
	})
]);
export type TextTerminologyEntry = Schema.Schema.Type<typeof TextTerminologyEntry>;

/**
 * Saved place affected by a quality finding, identified by occurrence ID with file and location
 * evidence. It does not itself grant mutation capability.
 */
export const TextQualityAffectedOccurrence = Schema.Struct({
	id: TextOccurrenceId,
	location: TextLocation,
	packageFile: Schema.String
});
export type TextQualityAffectedOccurrence = Schema.Schema.Type<
	typeof TextQualityAffectedOccurrence
>;

/**
 * Observed source text and nonnegative character count for a budget finding. Interpret the
 * count with the matching rule rather than treating it as an Unreal storage limit.
 */
export const CharacterBudgetActual = Schema.Struct({
	characterCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	kind: Schema.Literal("character_count"),
	source: Schema.String
});
/**
 * Positive authored maximum character count. This is configurable display/content policy,
 * separate from saved-text decoding validity.
 */
export const CharacterBudgetExpectation = Schema.Struct({
	kind: Schema.Literal("maximum_characters"),
	maximumCharacters: PositiveInt
});
/**
 * Matched term and UTF-16 start/end offsets in the observed source. end is exclusive; preserve
 * the original source when presenting the match.
 */
export const TerminologyActual = Schema.Struct({
	end: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	kind: Schema.Literal("terminology_match"),
	source: Schema.String,
	start: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	term: EvidenceValue
});
/**
 * Authored forbidden term or preferred replacement expectation. A finding suggests policy
 * correction and does not apply a replacement automatically.
 */
export const TerminologyExpectation = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("forbidden_term"), term: EvidenceValue }),
	Schema.Struct({
		discouragedTerm: EvidenceValue,
		kind: Schema.Literal("preferred_term"),
		preferredTerm: EvidenceValue
	})
]);

const FindingBase = {
	affectedOccurrences: Schema.Array(TextQualityAffectedOccurrence).check(Schema.isMinLength(1)),
	recovery: AuthoredGuidance,
	role: TextRoleId,
	ruleId: TextQualityRuleId,
	textUnitId: TextUnitId
};

/**
 * Source character-budget or terminology finding with role/rule identity, affected places and
 * recovery. Findings report policy evidence without changing the source asset.
 */
export const TextQualityFinding = Schema.Union([
	Schema.Struct({
		...FindingBase,
		actual: CharacterBudgetActual,
		expectation: CharacterBudgetExpectation,
		kind: Schema.Literal("character_budget")
	}),
	Schema.Struct({
		...FindingBase,
		actual: TerminologyActual,
		expectation: TerminologyExpectation,
		kind: Schema.Literal("terminology")
	})
]);
export type TextQualityFinding = Schema.Schema.Type<typeof TextQualityFinding>;

/**
 * Matched occurrence and distinct unit counts for one role. Multiple occurrences of one unit
 * contribute separately only to matchedOccurrences.
 */
export const TextQualityRoleSummary = Schema.Struct({
	matchedOccurrences: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	matchedTextUnits: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	role: TextRoleId
});
export type TextQualityRoleSummary = Schema.Schema.Type<typeof TextQualityRoleSummary>;

/**
 * Finding count associated with one authored rule ID. Counts depend on the selected corpus and
 * policy version.
 */
export const TextQualityRuleSummary = Schema.Struct({
	findingCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	ruleId: TextQualityRuleId
});
export type TextQualityRuleSummary = Schema.Schema.Type<typeof TextQualityRuleSummary>;

/**
 * Versioned source-quality report retaining corpus coverage and diagnostic totals alongside
 * findings. A partial corpus cannot establish a project-wide clean policy result.
 */
export const TextQualityReport = Schema.Struct({
	coverage: TextCorpus.fields.coverage,
	...TextCorpusDiagnosticSummary.fields,
	findings: Schema.Array(TextQualityFinding),
	roles: Schema.Array(TextQualityRoleSummary),
	ruleDocumentVersion: Schema.Literal(1),
	rules: Schema.Array(TextQualityRuleSummary),
	schemaVersion: Schema.Literal(1),
	status: TextCorpus.fields.status
});
export type TextQualityReport = Schema.Schema.Type<typeof TextQualityReport>;

/**
 * Validates an external quality report as a domain response. Contract failures retain typed
 * guidance; this does not rerun policy evaluation on the report's source assets.
 */
export const parseTextQualityReport = gameTextResponseParser(TextQualityReport, "quality report");
