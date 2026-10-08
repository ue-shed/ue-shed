import { Schema } from "effect";
import { LocalizationTarget, LocalizationTargetName, CultureCode } from "./schema.js";

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const ProcessPath = Schema.NonEmptyString.check(
	Schema.isMaxLength(32_767),
	Schema.makeFilter((value) => !/[\u0000\r\n"]/u.test(value))
);
export const LocalizationOperation = Schema.Literals([
	"gather",
	"import",
	"export",
	"compile",
	"reports",
	"sync"
]);
export type LocalizationOperation = typeof LocalizationOperation.Type;
export const LocalizationEngine = Schema.Literals(["4.27", "5.7", "5.8"]);
export type LocalizationEngine = typeof LocalizationEngine.Type;
export const LocalizationStepKind = Schema.Literals([
	"gather_source",
	"gather_assets",
	"gather_metadata",
	"manifest",
	"archive",
	"import",
	"export",
	"compile",
	"reports"
]);
export type LocalizationStepKind = typeof LocalizationStepKind.Type;
export const LocalizationPlannedStep = Schema.Struct({
	index: Count,
	config: Schema.String,
	sectionIndex: Count,
	commandletClass: Schema.NonEmptyString,
	kind: LocalizationStepKind
});
export type LocalizationPlannedStep = typeof LocalizationPlannedStep.Type;
export const LocalizationPlannedFile = Schema.Struct({
	relativePath: Schema.NonEmptyString,
	kind: Schema.Literals([
		"manifest",
		"archive",
		"po",
		"locres",
		"locmeta",
		"word_count",
		"conflicts"
	]),
	culture: Schema.optionalKey(CultureCode)
});
export type LocalizationPlannedFile = typeof LocalizationPlannedFile.Type;
export const LocalizationOperationPlan = Schema.Struct({
	schemaVersion: Schema.Literal(1),
	operation: LocalizationOperation,
	target: LocalizationTargetName,
	engine: LocalizationEngine,
	projectDescriptor: ProcessPath,
	logPath: ProcessPath,
	configs: Schema.Array(Schema.NonEmptyString).check(Schema.isMaxLength(64)),
	arguments: Schema.Array(Schema.String),
	steps: Schema.Array(LocalizationPlannedStep).check(Schema.isMaxLength(1024)),
	files: Schema.Array(LocalizationPlannedFile).check(Schema.isMaxLength(100_000)),
	wholeRecipe: Schema.Boolean,
	auditExcludedDirectories: Schema.Array(Schema.String)
});
export type LocalizationOperationPlan = typeof LocalizationOperationPlan.Type;
export const LocalizationPlanningRequest = Schema.Struct({
	operation: LocalizationOperation,
	target: LocalizationTarget,
	engine: LocalizationEngine,
	projectDescriptor: ProcessPath,
	logPath: ProcessPath
});
export type LocalizationPlanningRequest = typeof LocalizationPlanningRequest.Type;
export const LocalizationRunRequest = Schema.Struct({
	operation: LocalizationOperation,
	target: LocalizationTarget,
	projectRoot: Schema.NonEmptyString,
	explicitEngineRoot: Schema.optionalKey(Schema.NonEmptyString),
	timeoutSeconds: Schema.optionalKey(
		Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 86_400 }))
	)
});
export type LocalizationRunRequest = typeof LocalizationRunRequest.Type;
export class LocalizationOperationError extends Schema.TaggedErrorClass<LocalizationOperationError>()(
	"LocalizationOperationError",
	{
		code: Schema.Literals([
			"invalid_request",
			"unsupported_engine",
			"engine_not_found",
			"engine_ambiguous",
			"missing_config",
			"unsupported_operation",
			"unsupported_config",
			"unsafe_path",
			"project_missing",
			"project_ambiguous",
			"commandlet_missing",
			"launch_failed",
			"commandlet_failed",
			"project_locked",
			"timeout",
			"cancelled",
			"termination_failed",
			"io_failed",
			"limit_exceeded",
			"config_changed",
			"target_not_found"
		]),
		message: Schema.String,
		recovery: Schema.String,
		retrySafe: Schema.Boolean,
		logExcerpt: Schema.Array(Schema.String).check(Schema.isMaxLength(40)),
		logPath: Schema.optionalKey(Schema.String),
		exitCode: Schema.optionalKey(Schema.NullOr(Schema.Int))
	}
) {}
export const LocalizationProgress = Schema.Struct({
	schemaVersion: Schema.Literal(1),
	type: Schema.Literal("progress"),
	phase: Schema.Literals(["started", "completed"]),
	stepIndex: Count,
	stepTotal: Count,
	kind: LocalizationStepKind
});
export type LocalizationProgress = typeof LocalizationProgress.Type;
export const LocalizationFileChange = Schema.Struct({
	relativePath: Schema.NonEmptyString,
	beforeHash: Schema.NullOr(Schema.String),
	afterHash: Schema.NullOr(Schema.String),
	planned: Schema.Boolean
});
export type LocalizationFileChange = typeof LocalizationFileChange.Type;
export const LocalizationOperationReceipt = Schema.Struct({
	schemaVersion: Schema.Literal(1),
	type: Schema.Literal("receipt"),
	operation: LocalizationOperation,
	target: LocalizationTargetName,
	status: Schema.Literals(["completed", "planning_defect"]),
	durationMs: Count,
	pid: Schema.Int,
	logPath: Schema.String,
	plan: LocalizationOperationPlan,
	changes: Schema.Array(LocalizationFileChange),
	diagnostics: Schema.Array(
		Schema.Struct({
			code: Schema.Literal("unplanned_file_change"),
			relativePath: Schema.String
		})
	)
});
export type LocalizationOperationReceipt = typeof LocalizationOperationReceipt.Type;
export const LocalizationProcessStarted = Schema.Struct({
	schemaVersion: Schema.Literal(1),
	type: Schema.Literal("process_started"),
	pid: Schema.Int.check(Schema.isGreaterThan(0)),
	logPath: Schema.String
});
export const LocalizationRunEvent = Schema.Union([
	LocalizationProcessStarted,
	LocalizationProgress,
	LocalizationOperationReceipt
]);
export type LocalizationRunEvent = typeof LocalizationRunEvent.Type;
