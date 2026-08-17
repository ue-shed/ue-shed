import { CustodianReport } from "@ue-shed/project-custodian/browser";
import { type Effect, Schema } from "effect";

export const CustodianPublicError = Schema.Struct({
	code: Schema.Literals(["scan_failed", "dialog_failed"]),
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
}
