import { Schema } from "effect";

const Bytes = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const NonNegativeNumber = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0));

export const ProjectTargetKey = Schema.Literals([
	"intermediate",
	"plugin_intermediate",
	"binaries",
	"plugin_binaries",
	"build",
	"ddc",
	"cooked",
	"staged",
	"logs",
	"crashes",
	"autosaves",
	"saved_config"
]);
export type ProjectTargetKey = typeof ProjectTargetKey.Type;

export const EngineTargetKey = Schema.Literals([
	"engine_ddc",
	"engine_logs",
	"engine_crashes",
	"engine_intermediate",
	"engine_binaries"
]);
export type EngineTargetKey = typeof EngineTargetKey.Type;

export const CustodianPolicy = Schema.Struct({
	enabled: Schema.Boolean,
	minAgeDays: NonNegativeNumber,
	minFreeGb: NonNegativeNumber,
	keepBinariesForCpp: Schema.Boolean,
	targets: Schema.Array(ProjectTargetKey),
	source: Schema.Literals(["default", "project"])
});
export interface CustodianPolicy extends Schema.Schema.Type<typeof CustodianPolicy> {}

export const CustodianFreshness = Schema.Struct({
	authoredAt: Schema.optionalKey(Schema.String),
	lastSessionAt: Schema.optionalKey(Schema.String),
	effectiveAt: Schema.optionalKey(Schema.String),
	ageDays: Schema.optionalKey(NonNegativeNumber),
	mtimesLookRewritten: Schema.Boolean
});
export interface CustodianFreshness extends Schema.Schema.Type<typeof CustodianFreshness> {}

export const CustodianTarget = Schema.Struct({
	key: Schema.Union([ProjectTargetKey, EngineTargetKey]),
	path: Schema.NonEmptyString,
	relativePath: Schema.NonEmptyString,
	bytes: Bytes,
	description: Schema.NonEmptyString,
	rebuildCost: Schema.NonEmptyString,
	risk: Schema.Literals(["low", "medium", "high", "critical"])
});
export interface CustodianTarget extends Schema.Schema.Type<typeof CustodianTarget> {}

export const CustodianRefusal = Schema.Struct({
	path: Schema.NonEmptyString,
	relativePath: Schema.NonEmptyString,
	code: Schema.Literals([
		"protected_path",
		"outside_root",
		"different_volume",
		"installed_engine",
		"unreadable"
	]),
	reason: Schema.NonEmptyString
});
export interface CustodianRefusal extends Schema.Schema.Type<typeof CustodianRefusal> {}

export const CustodianDiagnostic = Schema.Struct({
	code: Schema.Literals([
		"invalid_policy",
		"descriptor_unreadable",
		"target_unreadable",
		"discovery_incomplete",
		"cross_volume_skipped",
		"hardlink_excluded"
	]),
	message: Schema.NonEmptyString,
	path: Schema.optionalKey(Schema.NonEmptyString)
});
export interface CustodianDiagnostic extends Schema.Schema.Type<typeof CustodianDiagnostic> {}

export const ProjectEligibility = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("candidate") }),
	Schema.Struct({ kind: Schema.Literal("opted_out") }),
	Schema.Struct({ kind: Schema.Literal("recent"), eligibleAfterDays: NonNegativeNumber }),
	Schema.Struct({ kind: Schema.Literal("unknown_age") }),
	Schema.Struct({ kind: Schema.Literal("empty") }),
	Schema.Struct({ kind: Schema.Literal("invalid_policy") })
]);
export type ProjectEligibility = typeof ProjectEligibility.Type;

export const CustodianProjectReport = Schema.Struct({
	kind: Schema.Literal("project"),
	name: Schema.NonEmptyString,
	root: Schema.NonEmptyString,
	descriptor: Schema.NonEmptyString,
	engineAssociation: Schema.NonEmptyString,
	isCpp: Schema.Boolean,
	policy: CustodianPolicy,
	freshness: CustodianFreshness,
	eligibility: ProjectEligibility,
	targets: Schema.Array(CustodianTarget),
	refusals: Schema.Array(CustodianRefusal),
	diagnostics: Schema.Array(CustodianDiagnostic),
	reclaimableBytes: Bytes
});
export interface CustodianProjectReport extends Schema.Schema.Type<typeof CustodianProjectReport> {}

export const CustodianEngineReport = Schema.Struct({
	kind: Schema.Literal("engine"),
	name: Schema.NonEmptyString,
	root: Schema.NonEmptyString,
	version: Schema.NonEmptyString,
	buildKind: Schema.Literals(["installed", "source"]),
	targets: Schema.Array(CustodianTarget),
	refusals: Schema.Array(CustodianRefusal),
	diagnostics: Schema.Array(CustodianDiagnostic),
	reclaimableBytes: Bytes
});
export interface CustodianEngineReport extends Schema.Schema.Type<typeof CustodianEngineReport> {}

export const CustodianPlanItem = Schema.Struct({
	kind: Schema.Literals(["project", "engine"]),
	name: Schema.NonEmptyString,
	root: Schema.NonEmptyString,
	bytes: Bytes,
	targets: Schema.Array(CustodianTarget)
});
export interface CustodianPlanItem extends Schema.Schema.Type<typeof CustodianPlanItem> {}

export const CustodianPlan = Schema.Struct({
	status: Schema.Literals(["ready", "pressure_satisfied", "nothing_eligible"]),
	freeBytes: Bytes,
	thresholdBytes: Bytes,
	projectedFreeBytes: Bytes,
	reclaimableBytes: Bytes,
	items: Schema.Array(CustodianPlanItem)
});
export interface CustodianPlan extends Schema.Schema.Type<typeof CustodianPlan> {}

export const CustodianScanRequest = Schema.Struct({
	root: Schema.NonEmptyString,
	ignorePressure: Schema.optionalKey(Schema.Boolean)
});
export interface CustodianScanRequest extends Schema.Schema.Type<typeof CustodianScanRequest> {}

export const CustodianReport = Schema.Struct({
	schemaVersion: Schema.Literal(1),
	root: Schema.NonEmptyString,
	measuredAt: Schema.String,
	freeBytes: Bytes,
	totalReclaimableBytes: Bytes,
	projects: Schema.Array(CustodianProjectReport),
	engines: Schema.Array(CustodianEngineReport),
	diagnostics: Schema.Array(CustodianDiagnostic),
	plan: CustodianPlan,
	destructiveOperationsAvailable: Schema.Literal(false)
});
export interface CustodianReport extends Schema.Schema.Type<typeof CustodianReport> {}

export const decodeCustodianScanRequest = Schema.decodeUnknownEffect(CustodianScanRequest);
export const decodeCustodianReport = Schema.decodeUnknownEffect(CustodianReport);
