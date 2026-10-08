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
export const OperationRelativePath = Schema.NonEmptyString.check(
	Schema.isMaxLength(1024),
	Schema.makeFilter(
		(path) =>
			!path.startsWith("/") &&
			!/[\\:\u0000\r\n]/u.test(path) &&
			!path.split("/").some((part) => part === ".." || part === ".")
	)
);
export const WorkbenchOperationRequest = Schema.Struct({
	target: LocalizationTargetName,
	operation: LocalizationOperation
});
export type WorkbenchOperationRequest = typeof WorkbenchOperationRequest.Type;
export const WorkbenchOperationFailure = Schema.Struct({
	status: Schema.Literal("failed"),
	code: Text,
	message: Text,
	recovery: Text,
	details: Schema.Array(Text).check(Schema.isMaxLength(40))
});
export type WorkbenchOperationFailure = typeof WorkbenchOperationFailure.Type;
export const WorkbenchOperationPlan = Schema.Struct({
	id: Id,
	target: LocalizationTargetName,
	operation: LocalizationOperation,
	engine: LocalizationEngine,
	wholeRecipe: Schema.Boolean,
	steps: Schema.Array(LocalizationStepKind).check(Schema.isMaxLength(1024)),
	fileCount: Count
});
export type WorkbenchOperationPlan = typeof WorkbenchOperationPlan.Type;
export const WorkbenchOperationPlanResult = Schema.Union([
	Schema.Struct({ status: Schema.Literal("ready"), plan: WorkbenchOperationPlan }),
	WorkbenchOperationFailure
]);
export type WorkbenchOperationPlanResult = typeof WorkbenchOperationPlanResult.Type;
export const WorkbenchOperationReceipt = Schema.Struct({
	id: Id,
	target: LocalizationTargetName,
	operation: LocalizationOperation,
	changedFiles: Count,
	unplannedFiles: Count,
	translationsImported: Count,
	refreshed: Schema.Boolean
});
export type WorkbenchOperationReceipt = typeof WorkbenchOperationReceipt.Type;
export const WorkbenchOperationResult = Schema.Union([
	Schema.Struct({ status: Schema.Literal("completed"), receipt: WorkbenchOperationReceipt }),
	Schema.Struct({ status: Schema.Literal("cancelled") }),
	WorkbenchOperationFailure
]);
export type WorkbenchOperationResult = typeof WorkbenchOperationResult.Type;
export const WorkbenchOperationProgress = Schema.Struct({
	id: Id,
	target: LocalizationTargetName,
	operation: LocalizationOperation,
	phase: Schema.Literals(["starting", "running", "refreshing"]),
	stepIndex: Count,
	stepTotal: Count,
	kind: Schema.optionalKey(LocalizationStepKind)
});
export type WorkbenchOperationProgress = typeof WorkbenchOperationProgress.Type;
export const WorkbenchOperationState = Schema.Struct({
	operations: Schema.Array(LocalizationOperation).check(
		Schema.isMaxLength(LocalizationOperation.literals.length)
	),
	wholeRecipe: Schema.Boolean,
	busyReason: Schema.optionalKey(Text),
	progress: Schema.optionalKey(WorkbenchOperationProgress),
	result: Schema.optionalKey(WorkbenchOperationResult)
});
export type WorkbenchOperationState = typeof WorkbenchOperationState.Type;
export const WorkbenchOperationId = Id;
export const WorkbenchOperationTarget = LocalizationTargetName;
export const WorkbenchOperationFilesRequest = Schema.Struct({
	id: Id,
	kind: Schema.Literals(["planned", "changed"]),
	offset: Schema.optionalKey(Count)
});
export type WorkbenchOperationFilesRequest = typeof WorkbenchOperationFilesRequest.Type;
export const WorkbenchOperationFilesResult = Schema.Union([
	Schema.Struct({
		status: Schema.Literal("ready"),
		files: Schema.Array(
			Schema.Struct({ path: OperationRelativePath, planned: Schema.Boolean })
		).check(Schema.isMaxLength(50)),
		total: Count,
		nextOffset: Schema.optionalKey(Count)
	}),
	WorkbenchOperationFailure
]);
export type WorkbenchOperationFilesResult = typeof WorkbenchOperationFilesResult.Type;
