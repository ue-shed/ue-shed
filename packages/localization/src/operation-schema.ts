import { Schema } from "effect";
import {
	LocalizationErrorGuidanceFields as ErrorGuidanceFields,
	LocalizationTarget,
	LocalizationTargetName,
	CultureCode
} from "./schema.js";

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const ProcessPath = Schema.NonEmptyString.check(
	Schema.isMaxLength(32_767),
	Schema.makeFilter((value) => !/[\u0000\r\n"]/u.test(value))
);
/**
 * Supported explicit commandlet workflows. prepare gathers then exports in one GatherText
 * run; read-only evidence discovery is a separate API and never invokes these operations.
 */
export const LocalizationOperation = Schema.Literals([
	"gather",
	"import",
	"export",
	"compile",
	"reports",
	"sync",
	// Gather, then export PO files, in one GatherText run.
	"prepare"
]);
export type LocalizationOperation = typeof LocalizationOperation.Type;
/**
 * Engine versions supported by localization operation planning: 4.27, 5.7 and 5.8. Discovery
 * of another installation does not imply its recipes are accepted by this planner.
 */
export const LocalizationEngine = Schema.Literals(["4.27", "5.7", "5.8"]);
export type LocalizationEngine = typeof LocalizationEngine.Type;
/**
 * Recognized GatherText step roles used in plans and progress. These describe Unreal
 * commandlet work rather than toolkit translation-quality checks.
 */
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
/**
 * One selected config section, preserving config path, section index, commandlet class and
 * recognized role. Its plan index determines execution/progress ordering.
 */
export const LocalizationPlannedStep = Schema.Struct({
	index: Count,
	config: Schema.String,
	sectionIndex: Count,
	commandletClass: Schema.NonEmptyString,
	kind: LocalizationStepKind
});
export type LocalizationPlannedStep = typeof LocalizationPlannedStep.Type;
/**
 * Expected project-relative output and kind, with a culture when applicable. Actual post-run
 * file changes are audited against this declaration.
 */
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
/**
 * Version-1 reviewed execution plan with engine, arguments, selected steps and expected
 * outputs. Planning does not run commandlets; execution revalidates config and audits
 * unexpected file changes.
 */
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
/**
 * Pure planning input binding an operation to discovered target recipes, supported engine,
 * descriptor and private log path. It does not perform engine discovery or process launch.
 */
export const LocalizationPlanningRequest = Schema.Struct({
	operation: LocalizationOperation,
	target: LocalizationTarget,
	engine: LocalizationEngine,
	projectDescriptor: ProcessPath,
	logPath: ProcessPath
});
export type LocalizationPlanningRequest = typeof LocalizationPlanningRequest.Type;
/**
 * Explicit project/target operation with optional engine root and timeout in seconds (1
 * through 86,400). The runner owns its commandlet process tree and reports partial-output
 * recovery.
 */
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
/**
 * Planning or commandlet lifecycle failure with code, private log location/excerpt and
 * optional original cause. Failures after execution may leave output; honor reconciliation
 * guidance before another run.
 */
export class LocalizationOperationError extends Schema.TaggedError<LocalizationOperationError>()(
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
		...ErrorGuidanceFields,
		logExcerpt: Schema.Array(Schema.String).check(Schema.isMaxLength(40)),
		logPath: Schema.optionalKey(Schema.String),
		exitCode: Schema.optionalKey(Schema.NullOr(Schema.Int)),
		cause: Schema.optionalKey(Schema.Defect())
	}
) {}
/** Tag guard for localization operation failures; match by tag, not `instanceof`. */
export const isLocalizationOperationError = Schema.is(LocalizationOperationError);
/**
 * Version-1 started/completed step event with index, total and recognized role. Progress is
 * evidence of commandlet activity; only a receipt reports the overall audited outcome.
 */
export const LocalizationProgress = Schema.Struct({
	schemaVersion: Schema.Literal(1),
	type: Schema.Literal("progress"),
	phase: Schema.Literals(["started", "completed"]),
	stepIndex: Count,
	stepTotal: Count,
	kind: LocalizationStepKind
});
export type LocalizationProgress = typeof LocalizationProgress.Type;
/**
 * Audited relative file change with before/after hashes and whether the plan declared it. A
 * null hash denotes absence before or after the run.
 */
export const LocalizationFileChange = Schema.Struct({
	relativePath: Schema.NonEmptyString,
	beforeHash: Schema.NullOr(Schema.String),
	afterHash: Schema.NullOr(Schema.String),
	planned: Schema.Boolean
});
export type LocalizationFileChange = typeof LocalizationFileChange.Type;
/**
 * Audited commandlet completion with timing, PID, private log, plan and file changes.
 * planning_defect reports unplanned writes even when the process completed successfully.
 */
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
/**
 * Process launch event carrying the owned PID and private log path. It does not imply
 * commandlet success, completion or that all output files were planned.
 */
export const LocalizationProcessStarted = Schema.Struct({
	schemaVersion: Schema.Literal(1),
	type: Schema.Literal("process_started"),
	pid: Schema.Int.check(Schema.isGreaterThan(0)),
	logPath: Schema.String
});
/**
 * Discriminated stream of process start, step progress and final audited receipt. Stream
 * interruption closes the owned process scope; inspect errors/partial output before replaying
 * mutations.
 */
export const LocalizationRunEvent = Schema.Union([
	LocalizationProcessStarted,
	LocalizationProgress,
	LocalizationOperationReceipt
]);
export type LocalizationRunEvent = typeof LocalizationRunEvent.Type;
