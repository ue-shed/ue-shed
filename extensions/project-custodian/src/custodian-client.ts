import { ErrorNextStep } from "@ue-shed/protocol/errors";
import {
	CustodianCancelResult,
	CustodianExecutionMode,
	CustodianProposal,
	CustodianProposalId,
	CustodianReceipt,
	CustodianReport,
	CustodianTargetId
} from "@ue-shed/project-custodian/browser";
import { Effect, Schema } from "effect";

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

/**
 * A value that does not match the Project Custodian client contract: the two sides disagree about the contract, so
 * repeating the same call returns the same mismatch.
 */
export class CustodianClientContractError extends Schema.TaggedError<CustodianClientContractError>()(
	"CustodianClientContractError",
	{
		nextStep: ErrorNextStep,
		code: Schema.Literal("invalid_contract"),
		message: Schema.String,
		recovery: Schema.String,
		retrySafe: Schema.Boolean,
		cause: Schema.optionalKey(Schema.Defect())
	}
) {}

/**
 * A unary parser for one Project Custodian client contract value: it decodes the encoded value and fails with
 * `CustodianClientContractError` naming `subject`, keeping the schema issue as its cause.
 */
function custodianClientContractParser<S extends Schema.Codec<unknown, unknown>>(
	schema: S,
	subject: string
) {
	const decode = Schema.decodeUnknownEffect(schema);
	return (
		// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This parser is the boundary: it decodes its input here.
		encoded: unknown
	): Effect.Effect<S["Type"], CustodianClientContractError> =>
		decode(encoded).pipe(
			Effect.mapError(
				(cause) =>
					new CustodianClientContractError({
						nextStep: "escalate",
						code: "invalid_contract",
						message: `The ${subject} does not match the Project Custodian client contract.`,
						recovery:
							"Run Workbench and its extensions from the same UE Shed version, then retry.",
						retrySafe: false,
						cause
					})
			)
		);
}

export const parseCustodianRunResult = custodianClientContractParser(
	CustodianRunResult,
	"custodian run result"
);

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

export const parseCustodianPrepareRunResult = custodianClientContractParser(
	CustodianPrepareRunResult,
	"custodian prepare run result"
);
export const parseCustodianExecutionRunResult = custodianClientContractParser(
	CustodianExecutionRunResult,
	"custodian execution run result"
);
export const parseCustodianCancelResult = custodianClientContractParser(
	CustodianCancelResult,
	"custodian cancel result"
);

export const CustodianCancelRunResult = Schema.Union([
	Schema.Struct({ status: Schema.Literal("failed"), error: CustodianPublicError }),
	Schema.Struct({ status: Schema.Literal("completed"), result: CustodianCancelResult })
]);
export type CustodianCancelRunResult = typeof CustodianCancelRunResult.Type;
export const parseCustodianCancelRunResult = custodianClientContractParser(
	CustodianCancelRunResult,
	"custodian cancel run result"
);

export class CustodianClientError extends Schema.TaggedError<CustodianClientError>()(
	"ProjectCustodian.ClientError",
	{
		message: Schema.String,
		retrySafe: Schema.Boolean,
		nextStep: ErrorNextStep,
		code: Schema.Literal("custodian_client_failed"),
		cause: Schema.Defect(),
		operation: Schema.String,
		recovery: Schema.String
	}
) {}

export interface CustodianClientApi {
	readonly configuredScan: () => Effect.Effect<CustodianRunResult, CustodianClientError>;
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
