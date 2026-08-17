import {
	CustodianCancelResult,
	CustodianExecutionMode,
	CustodianProposal,
	CustodianProposalId,
	CustodianReceipt,
	CustodianReport,
	CustodianTargetId
} from "@ue-shed/project-custodian/browser";
import { type Effect, Schema } from "effect";

export const CustodianPublicError = Schema.Struct({
	code: Schema.Literals(["scan_failed", "dialog_failed", "prepare_failed", "execution_failed"]),
	message: Schema.NonEmptyString,
	recovery: Schema.NonEmptyString,
	retrySafe: Schema.Boolean
});
export interface CustodianPublicError extends Schema.Schema.Type<typeof CustodianPublicError> {}

export const CustodianRunResult = Schema.Union([
	Schema.Struct({ status: Schema.Literal("not_configured") }),
	Schema.Struct({ status: Schema.Literal("cancelled") }),
	Schema.Struct({ status: Schema.Literal("failed"), error: CustodianPublicError }),
	Schema.Struct({ status: Schema.Literal("completed"), report: CustodianReport })
]);
export type CustodianRunResult = typeof CustodianRunResult.Type;

export const decodeCustodianRunResult = Schema.decodeUnknownEffect(CustodianRunResult);

export const CustodianPrepareIntent = Schema.Struct({
	root: Schema.NonEmptyString,
	ignorePressure: Schema.Boolean,
	mode: CustodianExecutionMode,
	targetIds: Schema.Array(CustodianTargetId).check(Schema.isMinLength(1))
});
export interface CustodianPrepareIntent extends Schema.Schema.Type<typeof CustodianPrepareIntent> {}

export const CustodianPrepareRunResult = Schema.Union([
	Schema.Struct({ status: Schema.Literal("failed"), error: CustodianPublicError }),
	Schema.Struct({ status: Schema.Literal("completed"), proposal: CustodianProposal })
]);
export type CustodianPrepareRunResult = typeof CustodianPrepareRunResult.Type;

export const CustodianExecuteIntent = Schema.Struct({
	proposalPath: Schema.NonEmptyString,
	approvalPhrase: Schema.NonEmptyString
});
export interface CustodianExecuteIntent extends Schema.Schema.Type<typeof CustodianExecuteIntent> {}

export const CustodianExecutionRunResult = Schema.Union([
	Schema.Struct({ status: Schema.Literal("failed"), error: CustodianPublicError }),
	Schema.Struct({ status: Schema.Literal("completed"), receipt: CustodianReceipt })
]);
export type CustodianExecutionRunResult = typeof CustodianExecutionRunResult.Type;

export const decodeCustodianPrepareRunResult =
	Schema.decodeUnknownEffect(CustodianPrepareRunResult);
export const decodeCustodianExecutionRunResult = Schema.decodeUnknownEffect(
	CustodianExecutionRunResult
);
export const decodeCustodianCancelResult = Schema.decodeUnknownEffect(CustodianCancelResult);

export const CustodianCancelRunResult = Schema.Union([
	Schema.Struct({ status: Schema.Literal("failed"), error: CustodianPublicError }),
	Schema.Struct({ status: Schema.Literal("completed"), result: CustodianCancelResult })
]);
export type CustodianCancelRunResult = typeof CustodianCancelRunResult.Type;
export const decodeCustodianCancelRunResult = Schema.decodeUnknownEffect(CustodianCancelRunResult);

export class CustodianClientError extends Schema.TaggedErrorClass<CustodianClientError>()(
	"ProjectCustodian.ClientError",
	{
		cause: Schema.Defect(),
		operation: Schema.String,
		recovery: Schema.String
	}
) {}

export interface CustodianClientShape {
	readonly configuredScan: () => Effect.Effect<CustodianRunResult, CustodianClientError>;
	readonly chooseAndScan: () => Effect.Effect<CustodianRunResult, CustodianClientError>;
	readonly prepare: (
		intent: CustodianPrepareIntent
	) => Effect.Effect<CustodianPrepareRunResult, CustodianClientError>;
	readonly execute: (
		intent: CustodianExecuteIntent
	) => Effect.Effect<CustodianExecutionRunResult, CustodianClientError>;
	readonly cancel: (
		proposalId: CustodianProposalId
	) => Effect.Effect<CustodianCancelRunResult, CustodianClientError>;
}
