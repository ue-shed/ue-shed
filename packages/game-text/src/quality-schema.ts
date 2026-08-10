import { Effect, Schema } from "effect";
import {
	TextCorpus,
	TextCorpusDiagnostic,
	TextLocation,
	TextOccurrenceId,
	TextUnitId
} from "./schema.js";

const SafeIdentifier = Schema.Trim.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/));
const EvidenceValue = Schema.Trim.check(Schema.isNonEmpty(), Schema.isMaxLength(1024));
const AuthoredGuidance = Schema.Trim.check(Schema.isNonEmpty(), Schema.isMaxLength(2048));
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));
const EvidenceOperator = Schema.Literals(["exact", "prefix"]);

export const TextRoleId = SafeIdentifier.pipe(Schema.brand("TextRoleId"));
export type TextRoleId = Schema.Schema.Type<typeof TextRoleId>;

export const TextQualityRuleId = SafeIdentifier.pipe(Schema.brand("TextQualityRuleId"));
export type TextQualityRuleId = Schema.Schema.Type<typeof TextQualityRuleId>;

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

export const TextRoleScope = Schema.Struct({
	matchers: Schema.Array(TextRoleMatcher).check(Schema.isMinLength(1), Schema.isMaxLength(16))
});
export type TextRoleScope = Schema.Schema.Type<typeof TextRoleScope>;

export const TextRole = Schema.Struct({
	id: TextRoleId,
	description: Schema.optionalKey(AuthoredGuidance),
	scopes: Schema.Array(TextRoleScope).check(Schema.isMinLength(1), Schema.isMaxLength(64))
});
export type TextRole = Schema.Schema.Type<typeof TextRole>;

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

export const TextQualityRuleDocument = Schema.Struct({
	rules: Schema.Array(TextQualityRule).check(Schema.isMinLength(1), Schema.isMaxLength(512)),
	roles: Schema.Array(TextRole).check(Schema.isMinLength(1), Schema.isMaxLength(256)),
	schemaVersion: Schema.Literal(1)
});
export type TextQualityRuleDocument = Schema.Schema.Type<typeof TextQualityRuleDocument>;

export class TextQualityRuleDocumentError extends Schema.TaggedErrorClass<TextQualityRuleDocumentError>()(
	"TextQualityRuleDocumentError",
	{
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
	code: TextQualityRuleDocumentError["code"]
): TextQualityRuleDocumentError {
	switch (code) {
		case "invalid_json":
			return new TextQualityRuleDocumentError({
				code,
				message: "The Game Text quality rule file is not valid JSON.",
				recovery: "Correct the JSON syntax and retry with a version-1 rule document."
			});
		case "invalid_structure":
			return new TextQualityRuleDocumentError({
				code,
				message: "The Game Text quality rule document does not match the version-1 schema.",
				recovery:
					"Provide schemaVersion 1 with non-empty roles, scopes, matchers, rules, and authored recovery guidance."
			});
		case "duplicate_role_id":
			return new TextQualityRuleDocumentError({
				code,
				message: "The Game Text quality rule document contains a duplicate role ID.",
				recovery: "Give every role a unique stable ID and retry."
			});
		case "duplicate_rule_id":
			return new TextQualityRuleDocumentError({
				code,
				message: "The Game Text quality rule document contains a duplicate rule ID.",
				recovery: "Give every rule a unique stable ID and retry."
			});
		case "unknown_role_id":
			return new TextQualityRuleDocumentError({
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

export function decodeTextQualityRuleDocument(
	input: unknown
): Effect.Effect<TextQualityRuleDocument, TextQualityRuleDocumentError> {
	return Schema.decodeUnknownEffect(TextQualityRuleDocument)(input).pipe(
		Effect.mapError(() => ruleDocumentError("invalid_structure")),
		Effect.flatMap(validateRuleDocument)
	);
}

export function decodeTextQualityRuleDocumentJson(
	input: string
): Effect.Effect<TextQualityRuleDocument, TextQualityRuleDocumentError> {
	return Effect.try({
		try: (): unknown => JSON.parse(input),
		catch: () => ruleDocumentError("invalid_json")
	}).pipe(Effect.flatMap(decodeTextQualityRuleDocument));
}

export const TextQualityAffectedOccurrence = Schema.Struct({
	id: TextOccurrenceId,
	location: TextLocation,
	packageFile: Schema.String
});
export type TextQualityAffectedOccurrence = Schema.Schema.Type<
	typeof TextQualityAffectedOccurrence
>;

const CharacterBudgetActual = Schema.Struct({
	characterCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	kind: Schema.Literal("character_count"),
	source: Schema.String
});
const CharacterBudgetExpectation = Schema.Struct({
	kind: Schema.Literal("maximum_characters"),
	maximumCharacters: PositiveInt
});
const TerminologyActual = Schema.Struct({
	end: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	kind: Schema.Literal("terminology_match"),
	source: Schema.String,
	start: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	term: EvidenceValue
});
const TerminologyExpectation = Schema.Union([
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

export const TextQualityRoleSummary = Schema.Struct({
	matchedOccurrences: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	matchedTextUnits: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	role: TextRoleId
});
export type TextQualityRoleSummary = Schema.Schema.Type<typeof TextQualityRoleSummary>;

export const TextQualityRuleSummary = Schema.Struct({
	findingCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	ruleId: TextQualityRuleId
});
export type TextQualityRuleSummary = Schema.Schema.Type<typeof TextQualityRuleSummary>;

export const TextQualityReport = Schema.Struct({
	coverage: TextCorpus.fields.coverage,
	diagnostics: Schema.Array(TextCorpusDiagnostic),
	findings: Schema.Array(TextQualityFinding),
	roles: Schema.Array(TextQualityRoleSummary),
	ruleDocumentVersion: TextQualityRuleDocument.fields.schemaVersion,
	rules: Schema.Array(TextQualityRuleSummary),
	schemaVersion: Schema.Literal(1),
	status: TextCorpus.fields.status
});
export type TextQualityReport = Schema.Schema.Type<typeof TextQualityReport>;

export const decodeTextQualityReport = Schema.decodeUnknownEffect(TextQualityReport);
