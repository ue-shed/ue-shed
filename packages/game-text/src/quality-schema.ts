import { TextCorpusDiagnosticSummary } from "./corpus-summary.js";
import { Effect, Schema } from "effect";
import { BuiltInCheckId } from "./localization-check-ids.js";
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
 * Role-scoped source character-budget or terminology rule with authored recovery. Validation
 * ensures its role exists before quality evaluation.
 */
export const TextQualityRule = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("character_budget"),
		id: TextQualityRuleId,
		maximumCharacters: PositiveInt,
		recovery: AuthoredGuidance,
		role: TextRoleId
	}),
	Schema.Struct({
		kind: Schema.Literal("terminology"),
		caseSensitive: Schema.Boolean,
		id: TextQualityRuleId,
		recovery: AuthoredGuidance,
		role: TextRoleId,
		terms: Schema.Array(TextTerminologyEntry).check(
			Schema.isMinLength(1),
			Schema.isMaxLength(256)
		)
	})
]);
export type TextQualityRule = Schema.Schema.Type<typeof TextQualityRule>;

/**
 * Versioned source quality policy containing roles and rules. Use the domain decoders to
 * additionally reject duplicate IDs and unknown role references.
 */
export const TextQualityRuleDocument = Schema.Struct({
	disabledLocalizationChecks: Schema.optionalKey(Schema.Array(BuiltInCheckId)),
	/**
	 * Text the project uses to join segments of one line, such as `"//"`. When set, the
	 * `segment_separator` check expects each translation to use it as often as its source.
	 */
	segmentSeparator: Schema.optionalKey(
		Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(16))
	),
	/**
	 * Rich-text tag names a translation may use or leave out, such as a name style a culture
	 * applies differently. Compared without case; `rich_text_tags` and `rich_text_tags_added`
	 * ignore them.
	 */
	optionalTags: Schema.optionalKey(
		Schema.Array(Schema.String.check(Schema.isPattern(/^[A-Za-z_][\w.-]*$/u))).check(
			Schema.isMaxLength(256)
		)
	),
	/**
	 * Format argument names the game always supplies, so a translation may add them, such as a
	 * player's name a culture's grammar asks for. Case-sensitive, as argument names are. Adding
	 * one, or a rich-text tag wrapped around only that argument, is not reported.
	 */
	optionalArguments: Schema.optionalKey(
		Schema.Array(Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(128))).check(
			Schema.isMaxLength(256)
		)
	),
	rules: Schema.Array(TextQualityRule).check(Schema.isMinLength(1), Schema.isMaxLength(512)),
	roles: Schema.Array(TextRole).check(Schema.isMinLength(1), Schema.isMaxLength(256)),
	schemaVersion: Schema.Literal(1)
});
export type TextQualityRuleDocument = Schema.Schema.Type<typeof TextQualityRuleDocument>;

/**
 * Typed invalid JSON, structure or reference failure for source quality policy. Original parse
 * issues remain in cause; fix_input guidance identifies correction rather than retrying
 * unchanged input.
 */
export class TextQualityRuleDocumentError extends Schema.TaggedError<TextQualityRuleDocumentError>()(
	"TextQualityRuleDocumentError",
	{
		retrySafe: Schema.Boolean,
		nextStep: Schema.Literals(["fix_input", "retry", "reconcile", "escalate"]),
		cause: Schema.optionalKey(Schema.Defect()),
		code: Schema.Literals([
			"invalid_json",
			"invalid_structure",
			"duplicate_role_id",
			"duplicate_rule_id",
			"unknown_role_id"
		]),
		message: Schema.String,
		recovery: Schema.String
	}
) {}

function ruleDocumentError(
	code: TextQualityRuleDocumentError["code"],
	cause?: unknown
): TextQualityRuleDocumentError {
	switch (code) {
		case "invalid_json":
			return new TextQualityRuleDocumentError({
				...(cause === undefined ? undefined : { cause }),
				retrySafe: false,
				nextStep: "fix_input",
				code,
				message: "The Game Text quality rule file is not valid JSON.",
				recovery: "Correct the JSON syntax and retry with a version-1 rule document."
			});
		case "invalid_structure":
			return new TextQualityRuleDocumentError({
				...(cause === undefined ? undefined : { cause }),
				retrySafe: false,
				nextStep: "fix_input",
				code,
				message: "The Game Text quality rule document does not match the version-1 schema.",
				recovery:
					"Provide schemaVersion 1 with non-empty roles, scopes, matchers, rules, and authored recovery guidance."
			});
		case "duplicate_role_id":
			return new TextQualityRuleDocumentError({
				...(cause === undefined ? undefined : { cause }),
				retrySafe: false,
				nextStep: "fix_input",
				code,
				message: "The Game Text quality rule document contains a duplicate role ID.",
				recovery: "Give every role a unique stable ID and retry."
			});
		case "duplicate_rule_id":
			return new TextQualityRuleDocumentError({
				...(cause === undefined ? undefined : { cause }),
				retrySafe: false,
				nextStep: "fix_input",
				code,
				message: "The Game Text quality rule document contains a duplicate rule ID.",
				recovery: "Give every rule a unique stable ID and retry."
			});
		case "unknown_role_id":
			return new TextQualityRuleDocumentError({
				...(cause === undefined ? undefined : { cause }),
				retrySafe: false,
				nextStep: "fix_input",
				code,
				message: "A Game Text quality rule references a role that is not declared.",
				recovery:
					"Declare the referenced role or update the rule to use an existing role ID."
			});
	}
}

function firstDuplicate(values: readonly string[]): boolean {
	return new Set(values).size !== values.length;
}

function validateRuleDocument(
	document: TextQualityRuleDocument
): Effect.Effect<TextQualityRuleDocument, TextQualityRuleDocumentError> {
	if (firstDuplicate(document.roles.map((role) => role.id))) {
		return Effect.fail(ruleDocumentError("duplicate_role_id"));
	}
	if (firstDuplicate(document.rules.map((rule) => rule.id))) {
		return Effect.fail(ruleDocumentError("duplicate_rule_id"));
	}
	const roles = new Set(document.roles.map((role) => role.id));
	if (document.rules.some((rule) => !roles.has(rule.role))) {
		return Effect.fail(ruleDocumentError("unknown_role_id"));
	}
	return Effect.succeed(document);
}

/**
 * Validates an untrusted source policy object, unique role/rule IDs and role references.
 * Failures retain typed document guidance and the underlying schema issue when present.
 */
export function decodeTextQualityRuleDocument<Input>(
	input: Input
): Effect.Effect<TextQualityRuleDocument, TextQualityRuleDocumentError> {
	return Schema.decodeUnknownEffect(TextQualityRuleDocument)(input).pipe(
		Effect.mapError((cause) => ruleDocumentError("invalid_structure", cause)),
		Effect.flatMap(validateRuleDocument)
	);
}

/**
 * Parses source policy JSON and validates its structure and references. Invalid JSON remains
 * distinct from a structurally invalid document and retains its original cause.
 */
export function decodeTextQualityRuleDocumentJson(
	input: string
): Effect.Effect<TextQualityRuleDocument, TextQualityRuleDocumentError> {
	return Effect.try({
		try: () => Schema.decodeUnknownSync(Schema.Json)(JSON.parse(input)),
		catch: (cause) => ruleDocumentError("invalid_json", cause)
	}).pipe(Effect.flatMap(decodeTextQualityRuleDocument));
}

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
	ruleDocumentVersion: Schema.Literals([1, 2, 3]),
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
