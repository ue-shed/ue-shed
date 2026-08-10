import { Schema } from "effect";

export const ConfigPlatform = Schema.NonEmptyString.pipe(Schema.brand("ConfigPlatform"));
export type ConfigPlatform = typeof ConfigPlatform.Type;

export const ConfigFamily = Schema.NonEmptyString.pipe(Schema.brand("ConfigFamily"));
export type ConfigFamily = typeof ConfigFamily.Type;

export const ConfigSection = Schema.NonEmptyString.pipe(Schema.brand("ConfigSection"));
export type ConfigSection = typeof ConfigSection.Type;

export const ConfigKey = Schema.NonEmptyString.pipe(Schema.brand("ConfigKey"));
export type ConfigKey = typeof ConfigKey.Type;

export const ConfigSource = Schema.Struct({
	scope: Schema.Literals(["engine", "project"]),
	path: Schema.NonEmptyString
});
export type ConfigSource = typeof ConfigSource.Type;

export const ConfigSourceLocation = Schema.Struct({
	line: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
	column: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
});
export type ConfigSourceLocation = typeof ConfigSourceLocation.Type;

export const ConfigOperation = Schema.Literals([
	"set",
	"add_unique",
	"append",
	"remove",
	"clear",
	"initialize_empty"
]);
export type ConfigOperation = typeof ConfigOperation.Type;

export const ConfigValueState = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("missing") }),
	Schema.Struct({ kind: Schema.Literal("scalar"), value: Schema.String }),
	Schema.Struct({ kind: Schema.Literal("array"), values: Schema.Array(Schema.String) }),
	Schema.Struct({ kind: Schema.Literal("empty_array") })
]);
export type ConfigValueState = typeof ConfigValueState.Type;

export const ConfigContributionEffect = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("added"), index: Schema.Int }),
	Schema.Struct({
		kind: Schema.Literal("replaced"),
		index: Schema.Int,
		previousValue: Schema.String
	}),
	Schema.Struct({ kind: Schema.Literal("removed"), index: Schema.Int }),
	Schema.Struct({ kind: Schema.Literal("cleared"), removedValues: Schema.Array(Schema.String) }),
	Schema.Struct({
		kind: Schema.Literal("initialized_empty"),
		removedValues: Schema.Array(Schema.String)
	}),
	Schema.Struct({ kind: Schema.Literal("duplicate") }),
	Schema.Struct({ kind: Schema.Literal("no_match") })
]);
export type ConfigContributionEffect = typeof ConfigContributionEffect.Type;

export const ConfigContribution = Schema.Struct({
	sequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	source: ConfigSource,
	location: ConfigSourceLocation,
	operation: ConfigOperation,
	inputValue: Schema.optionalKey(Schema.String),
	priorValue: ConfigValueState,
	effect: ConfigContributionEffect,
	remainsEffective: Schema.Boolean
});
export type ConfigContribution = typeof ConfigContribution.Type;

export const ConfigDiagnostic = Schema.Struct({
	code: Schema.Literals([
		"unsupported_operator",
		"unsupported_multiline",
		"unsupported_config_redirect",
		"malformed_entry",
		"invalid_platform_parent",
		"path_redacted"
	]),
	message: Schema.String,
	source: Schema.optionalKey(ConfigSource),
	location: Schema.optionalKey(ConfigSourceLocation)
});
export type ConfigDiagnostic = typeof ConfigDiagnostic.Type;

export const ConfigLayerCoverage = Schema.Struct({
	order: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	layer: Schema.NonEmptyString,
	source: ConfigSource,
	status: Schema.Literals(["read", "missing", "unreadable", "unsupported", "excluded"]),
	detail: Schema.optionalKey(Schema.String)
});
export type ConfigLayerCoverage = typeof ConfigLayerCoverage.Type;

export const ConfigAuthorityCoverage = Schema.Struct({
	authority: Schema.Literals([
		"saved_generated",
		"user_private",
		"live_cvars",
		"device_profiles",
		"command_line",
		"cooked_staged",
		"dynamic_plugins",
		"runtime_mutation"
	]),
	status: Schema.Literals(["excluded", "unsupported"]),
	detail: Schema.String
});
export type ConfigAuthorityCoverage = typeof ConfigAuthorityCoverage.Type;

export const ConfigExplanation = Schema.Struct({
	schemaVersion: Schema.Literal(1),
	status: Schema.Literals(["complete", "partial"]),
	project: Schema.Struct({ descriptor: Schema.NonEmptyString }),
	platform: ConfigPlatform,
	family: ConfigFamily,
	section: ConfigSection,
	key: ConfigKey,
	effectiveValue: ConfigValueState,
	contributions: Schema.Array(ConfigContribution),
	layers: Schema.Array(ConfigLayerCoverage),
	authorities: Schema.Array(ConfigAuthorityCoverage),
	diagnostics: Schema.Array(ConfigDiagnostic)
});
export type ConfigExplanation = typeof ConfigExplanation.Type;

export const ConfigExplainRequest = Schema.Struct({
	project: Schema.NonEmptyString,
	platform: ConfigPlatform,
	section: ConfigSection,
	key: ConfigKey,
	engineRoot: Schema.optionalKey(Schema.NonEmptyString),
	family: Schema.optionalKey(ConfigFamily)
});
export type ConfigExplainRequest = typeof ConfigExplainRequest.Type;

export const ConfigComparison = Schema.Struct({
	schemaVersion: Schema.Literal(1),
	status: Schema.Literals(["same", "different", "partial"]),
	left: ConfigExplanation,
	right: ConfigExplanation,
	valueChanged: Schema.Boolean,
	coverageChanged: Schema.Boolean
});
export type ConfigComparison = typeof ConfigComparison.Type;

export const ConfigCompareRequest = Schema.Struct({
	project: ConfigExplainRequest.fields.project,
	leftPlatform: ConfigPlatform,
	rightPlatform: ConfigPlatform,
	section: ConfigSection,
	key: ConfigKey,
	engineRoot: Schema.optionalKey(Schema.NonEmptyString),
	family: Schema.optionalKey(ConfigFamily)
});
export type ConfigCompareRequest = typeof ConfigCompareRequest.Type;

export const ConfigExplorerPublicError = Schema.Struct({
	code: Schema.Literals([
		"invalid_request",
		"invalid_project",
		"engine_discovery_incomplete",
		"ambiguous_config_family",
		"invalid_platform",
		"resolution_failed"
	]),
	message: Schema.String,
	recovery: Schema.String,
	retrySafe: Schema.Boolean,
	candidates: Schema.optionalKey(Schema.Array(Schema.String))
});
export type ConfigExplorerPublicError = typeof ConfigExplorerPublicError.Type;

export const decodeConfigExplainRequest = Schema.decodeUnknownEffect(ConfigExplainRequest);
export const decodeConfigCompareRequest = Schema.decodeUnknownEffect(ConfigCompareRequest);
export const decodeConfigExplanation = Schema.decodeUnknownEffect(ConfigExplanation);
export const decodeConfigComparison = Schema.decodeUnknownEffect(ConfigComparison);
