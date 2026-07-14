import { Schema } from "effect";

export const TextureObjectPath = Schema.String.pipe(Schema.brand("TextureObjectPath"));
export type TextureObjectPath = Schema.Schema.Type<typeof TextureObjectPath>;

export const AuditRuleId = Schema.String.pipe(Schema.brand("AuditRuleId"));
export type AuditRuleId = Schema.Schema.Type<typeof AuditRuleId>;

export const EvidenceUnavailableReason = Schema.Literal(
	"not_serialized",
	"wrong_value_kind",
	"missing_source",
	"not_a_texture"
);

export const Evidence = <A, I>(value: Schema.Schema<A, I, never>) =>
	Schema.Union(
		Schema.Struct({
			status: Schema.Literal("available"),
			source: Schema.Literal("serialized", "file"),
			value
		}),
		Schema.Struct({
			status: Schema.Literal("unavailable"),
			reason: EvidenceUnavailableReason
		})
	);

const PositiveInt = Schema.Number.pipe(Schema.int(), Schema.positive());

export const Dimensions = Schema.Struct({ width: PositiveInt, height: PositiveInt });
export type Dimensions = Schema.Schema.Type<typeof Dimensions>;

export const StringEvidence = Evidence(Schema.String);
export const BooleanEvidence = Evidence(Schema.Boolean);
export const NumberEvidence = Evidence(Schema.NonNegativeInt);
export const DimensionsEvidence = Evidence(Dimensions);

export const TextureRecord = Schema.Struct({
	objectPath: TextureObjectPath,
	filePath: Schema.String,
	packageFileBytes: NumberEvidence,
	dimensions: DimensionsEvidence,
	sourceFormat: StringEvidence,
	sourceMips: NumberEvidence,
	compression: StringEvidence,
	sRGB: BooleanEvidence,
	textureGroup: StringEvidence,
	mipGeneration: StringEvidence
});
export type TextureRecord = Schema.Schema.Type<typeof TextureRecord>;

export const DimensionsPowerOfTwoRule = Schema.Struct({
	id: AuditRuleId,
	kind: Schema.Literal("dimensions_power_of_two"),
	severity: Schema.Literal("warning", "error")
});
export const MaxDimensionForTextureGroupRule = Schema.Struct({
	id: AuditRuleId,
	kind: Schema.Literal("max_dimension_for_texture_group"),
	textureGroup: Schema.String,
	maximum: PositiveInt,
	severity: Schema.Literal("warning", "error")
});
export const TextureAuditRule = Schema.Union(
	DimensionsPowerOfTwoRule,
	MaxDimensionForTextureGroupRule
);
export type TextureAuditRule = Schema.Schema.Type<typeof TextureAuditRule>;

export const TextureAuditRuleSet = Schema.Struct({
	schemaVersion: Schema.Literal(1),
	name: Schema.String,
	rules: Schema.Array(TextureAuditRule)
});
export type TextureAuditRuleSet = Schema.Schema.Type<typeof TextureAuditRuleSet>;

export const FindingEvidence = Schema.Struct({
	label: Schema.String,
	value: Schema.String
});
export const TextureAuditFinding = Schema.Struct({
	ruleId: AuditRuleId,
	severity: Schema.Literal("warning", "error"),
	objectPath: TextureObjectPath,
	explanation: Schema.String,
	actual: Schema.Array(FindingEvidence),
	expected: Schema.Array(FindingEvidence)
});
export type TextureAuditFinding = Schema.Schema.Type<typeof TextureAuditFinding>;

export const ScanDiagnostic = Schema.Struct({
	code: Schema.String,
	message: Schema.String,
	filePath: Schema.optional(Schema.String)
});
export type ScanDiagnostic = Schema.Schema.Type<typeof ScanDiagnostic>;

export const ScanCoverage = Schema.Struct({
	discoveredPackages: Schema.NonNegativeInt,
	inspectedPackages: Schema.NonNegativeInt,
	textureAssets: Schema.NonNegativeInt,
	partialPackages: Schema.NonNegativeInt,
	failedPackages: Schema.NonNegativeInt
});

export const DistributionBucket = Schema.Struct({
	key: Schema.String,
	label: Schema.String,
	count: Schema.NonNegativeInt
});
export type DistributionBucket = Schema.Schema.Type<typeof DistributionBucket>;

export const TextureDistributions = Schema.Struct({
	maximumDimension: Schema.Array(DistributionBucket),
	textureGroup: Schema.Array(DistributionBucket),
	compression: Schema.Array(DistributionBucket),
	sRGB: Schema.Array(DistributionBucket)
});
export type TextureDistributions = Schema.Schema.Type<typeof TextureDistributions>;

export const TextureAuditReport = Schema.Struct({
	schemaVersion: Schema.Literal(1),
	status: Schema.Literal("complete", "partial"),
	ruleSetName: Schema.String,
	coverage: ScanCoverage,
	records: Schema.Array(TextureRecord),
	findings: Schema.Array(TextureAuditFinding),
	distributions: TextureDistributions,
	diagnostics: Schema.Array(ScanDiagnostic)
});
export type TextureAuditReport = Schema.Schema.Type<typeof TextureAuditReport>;

export const TextureAuditPublicError = Schema.Struct({
	code: Schema.Literal("invalid_project", "invalid_rules", "scan_failed", "contract_failure"),
	message: Schema.String,
	recovery: Schema.String,
	retrySafe: Schema.Boolean
});
export type TextureAuditPublicError = Schema.Schema.Type<typeof TextureAuditPublicError>;

export const TextureAuditRunResult = Schema.Union(
	Schema.Struct({ status: Schema.Literal("completed"), report: TextureAuditReport }),
	Schema.Struct({ status: Schema.Literal("not_configured") }),
	Schema.Struct({ status: Schema.Literal("cancelled") }),
	Schema.Struct({ status: Schema.Literal("failed"), error: TextureAuditPublicError })
);
export type TextureAuditRunResult = Schema.Schema.Type<typeof TextureAuditRunResult>;

export const decodeTextureAuditRuleSet = Schema.decodeUnknownSync(TextureAuditRuleSet);
export const decodeTextureAuditRunResult = Schema.decodeUnknownSync(TextureAuditRunResult);
