import { Schema } from "effect";
import {
	LocalizationEngine,
	LocalizationOperation,
	LocalizationStepKind,
	LocalizationTargetName
} from "@ue-shed/localization/browser";

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Id = Schema.NonEmptyString.check(Schema.isMaxLength(80));
const Text = Schema.String.check(Schema.isMaxLength(2048));
/**
 * Bounded forward-slash project-relative operation path. Absolute paths, drive separators,
 * controls and dot traversal segments are rejected before file previews cross a host boundary.
 */
export const OperationRelativePath = Schema.NonEmptyString.check(
	Schema.isMaxLength(1024),
	Schema.makeFilter(
		(path) =>
			!path.startsWith("/") &&
			!/[\\:\u0000\r\n]/u.test(path) &&
			!path.split("/").some((part) => part === ".." || part === ".")
	)
);
/**
 * Selected target and localization operation to plan. Planning does not itself authorize a
 * different target or start an Unreal process.
 */
export const GameTextOperationRequest = Schema.Struct({
	target: LocalizationTargetName,
	operation: LocalizationOperation
});
export type GameTextOperationRequest = typeof GameTextOperationRequest.Type;
/**
 * Bounded serializable operation failure with stable code, human recovery and diagnostic detail
 * lines. It is a host response value rather than a thrown process-local exception.
 */
export const GameTextOperationFailure = Schema.Struct({
	status: Schema.Literal("failed"),
	code: Text,
	message: Text,
	recovery: Text,
	details: Schema.Array(Text).check(Schema.isMaxLength(40))
});
export type GameTextOperationFailure = typeof GameTextOperationFailure.Type;
/**
 * Prepared operation identity, discovered engine, steps and expected file count. Keep the plan
 * ID for execution and planned-file pagination.
 */
export const GameTextOperationPlan = Schema.Struct({
	id: Id,
	target: LocalizationTargetName,
	operation: LocalizationOperation,
	engine: LocalizationEngine,
	wholeRecipe: Schema.Boolean,
	steps: Schema.Array(LocalizationStepKind).check(Schema.isMaxLength(1024)),
	fileCount: Count
});
export type GameTextOperationPlan = typeof GameTextOperationPlan.Type;
/**
 * Operation planning outcome: a ready plan or explicit failure. A failure carries recovery
 * instead of an executable partial plan.
 */
export const GameTextOperationPlanResult = Schema.Union([
	Schema.Struct({ status: Schema.Literal("ready"), plan: GameTextOperationPlan }),
	GameTextOperationFailure
]);
export type GameTextOperationPlanResult = typeof GameTextOperationPlanResult.Type;
/**
 * Completed operation summary including changed/unplanned file counts, imported translations
 * and refresh status. Counts are evidence of effects, not a list of every path.
 */
export const GameTextOperationReceipt = Schema.Struct({
	id: Id,
	target: LocalizationTargetName,
	operation: LocalizationOperation,
	changedFiles: Count,
	unplannedFiles: Count,
	translationsImported: Count,
	refreshed: Schema.Boolean
});
export type GameTextOperationReceipt = typeof GameTextOperationReceipt.Type;
/**
 * Execution outcome distinguishing completion, cancellation and failure. A completed receipt
 * records whether derived Game Text state was refreshed.
 */
export const GameTextOperationResult = Schema.Union([
	Schema.Struct({ status: Schema.Literal("completed"), receipt: GameTextOperationReceipt }),
	Schema.Struct({ status: Schema.Literal("cancelled") }),
	GameTextOperationFailure
]);
export type GameTextOperationResult = typeof GameTextOperationResult.Type;
/**
 * Bounded operation progress for starting, running and refreshing phases. Step indices/counts
 * refer to the prepared recipe, not overall project scan progress.
 */
export const GameTextOperationProgress = Schema.Struct({
	id: Id,
	target: LocalizationTargetName,
	operation: LocalizationOperation,
	phase: Schema.Literals(["starting", "running", "refreshing"]),
	stepIndex: Count,
	stepTotal: Count,
	kind: Schema.optionalKey(LocalizationStepKind)
});
export type GameTextOperationProgress = typeof GameTextOperationProgress.Type;
/**
 * Available localization operations, busy explanation and optional live progress/result. Hosts
 * should honor busyReason before starting overlapping target work.
 */
export const GameTextOperationState = Schema.Struct({
	operations: Schema.Array(LocalizationOperation).check(
		Schema.isMaxLength(LocalizationOperation.literals.length)
	),
	wholeRecipe: Schema.Boolean,
	busyReason: Schema.optionalKey(Text),
	progress: Schema.optionalKey(GameTextOperationProgress),
	result: Schema.optionalKey(GameTextOperationResult)
});
export type GameTextOperationState = typeof GameTextOperationState.Type;
/**
 * Bounded nonempty operation identity used to reference a prepared plan or receipt. It is
 * opaque and does not encode a filesystem path.
 */
export const GameTextOperationId = Id;
/**
 * Localization target-name contract shared by operation planning and execution. It identifies
 * the selected target, independently of project selection owned by the host shell.
 */
export const GameTextOperationTarget = LocalizationTargetName;
/**
 * Offset-based request for planned or changed files belonging to an operation ID. File pages
 * are bounded independently from the operation's total file count.
 */
export const GameTextOperationFilesRequest = Schema.Struct({
	id: Id,
	kind: Schema.Literals(["planned", "changed"]),
	offset: Schema.optionalKey(Count)
});
export type GameTextOperationFilesRequest = typeof GameTextOperationFilesRequest.Type;
/**
 * Bounded operation file page with total and optional continuation offset, or explicit failure.
 * Each path is project-relative and records whether it was planned.
 */
export const GameTextOperationFilesResult = Schema.Union([
	Schema.Struct({
		status: Schema.Literal("ready"),
		files: Schema.Array(
			Schema.Struct({ path: OperationRelativePath, planned: Schema.Boolean })
		).check(Schema.isMaxLength(50)),
		total: Count,
		nextOffset: Schema.optionalKey(Count)
	}),
	GameTextOperationFailure
]);
export type GameTextOperationFilesResult = typeof GameTextOperationFilesResult.Type;

// Deprecated Workbench names (Plan 058 D10). Hosts other than Workbench run these
// operations too; use the GameTextOperation* names.
/** @deprecated Use `GameTextOperationRequest`. */
export const WorkbenchOperationRequest = GameTextOperationRequest;
/** @deprecated Use `GameTextOperationRequest`. */
export type WorkbenchOperationRequest = GameTextOperationRequest;
/** @deprecated Use `GameTextOperationFailure`. */
export const WorkbenchOperationFailure = GameTextOperationFailure;
/** @deprecated Use `GameTextOperationFailure`. */
export type WorkbenchOperationFailure = GameTextOperationFailure;
/** @deprecated Use `GameTextOperationPlan`. */
export const WorkbenchOperationPlan = GameTextOperationPlan;
/** @deprecated Use `GameTextOperationPlan`. */
export type WorkbenchOperationPlan = GameTextOperationPlan;
/** @deprecated Use `GameTextOperationPlanResult`. */
export const WorkbenchOperationPlanResult = GameTextOperationPlanResult;
/** @deprecated Use `GameTextOperationPlanResult`. */
export type WorkbenchOperationPlanResult = GameTextOperationPlanResult;
/** @deprecated Use `GameTextOperationReceipt`. */
export const WorkbenchOperationReceipt = GameTextOperationReceipt;
/** @deprecated Use `GameTextOperationReceipt`. */
export type WorkbenchOperationReceipt = GameTextOperationReceipt;
/** @deprecated Use `GameTextOperationResult`. */
export const WorkbenchOperationResult = GameTextOperationResult;
/** @deprecated Use `GameTextOperationResult`. */
export type WorkbenchOperationResult = GameTextOperationResult;
/** @deprecated Use `GameTextOperationProgress`. */
export const WorkbenchOperationProgress = GameTextOperationProgress;
/** @deprecated Use `GameTextOperationProgress`. */
export type WorkbenchOperationProgress = GameTextOperationProgress;
/** @deprecated Use `GameTextOperationState`. */
export const WorkbenchOperationState = GameTextOperationState;
/** @deprecated Use `GameTextOperationState`. */
export type WorkbenchOperationState = GameTextOperationState;
/** @deprecated Use `GameTextOperationId`. */
export const WorkbenchOperationId = GameTextOperationId;
/** @deprecated Use `GameTextOperationTarget`. */
export const WorkbenchOperationTarget = GameTextOperationTarget;
/** @deprecated Use `GameTextOperationFilesRequest`. */
export const WorkbenchOperationFilesRequest = GameTextOperationFilesRequest;
/** @deprecated Use `GameTextOperationFilesRequest`. */
export type WorkbenchOperationFilesRequest = GameTextOperationFilesRequest;
/** @deprecated Use `GameTextOperationFilesResult`. */
export const WorkbenchOperationFilesResult = GameTextOperationFilesResult;
/** @deprecated Use `GameTextOperationFilesResult`. */
export type WorkbenchOperationFilesResult = GameTextOperationFilesResult;
