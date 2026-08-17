import { Context, Effect, Layer, Schema } from "effect";
import { scanCustodian } from "./node-scanner.js";
import { CustodianScanRequest, decodeCustodianReport, type CustodianReport } from "./schema.js";

export class CustodianError extends Schema.TaggedErrorClass<CustodianError>()(
	"ProjectCustodian.Error",
	{
		code: Schema.Literals(["invalid_request", "scan_failed"]),
		message: Schema.String,
		recovery: Schema.String,
		retrySafe: Schema.Boolean,
		cause: Schema.Defect()
	}
) {}

export interface CustodianShape {
	readonly scan: (
		request: CustodianScanRequest
	) => Effect.Effect<CustodianReport, CustodianError>;
}

export class Custodian extends Context.Service<Custodian, CustodianShape>()(
	"@ue-shed/project-custodian/Custodian"
) {}

const scan = Effect.fn("ProjectCustodian.scan")(function* (input: CustodianScanRequest) {
	const request = yield* Schema.decodeUnknownEffect(CustodianScanRequest)(input).pipe(
		Effect.mapError(
			(cause) =>
				new CustodianError({
					code: "invalid_request",
					message: "The Project Custodian scan request is invalid.",
					recovery: "Provide one readable directory as the explicit scan root.",
					retrySafe: false,
					cause
				})
		)
	);
	const report = yield* Effect.tryPromise({
		try: (signal) => scanCustodian(request, signal),
		catch: (cause) =>
			new CustodianError({
				code: "scan_failed",
				message: `Project Custodian could not scan ${request.root}.`,
				recovery: "Choose a readable directory and retry. No files were changed.",
				retrySafe: true,
				cause
			})
	});
	return yield* decodeCustodianReport(report).pipe(
		Effect.mapError(
			(cause) =>
				new CustodianError({
					code: "scan_failed",
					message: "Project Custodian produced an invalid report.",
					recovery: "Update UE Shed and retry the scan. No files were changed.",
					retrySafe: false,
					cause
				})
		)
	);
});

export const CustodianNodeLive = Layer.succeed(Custodian, Custodian.of({ scan }));

export function makeCustodianTestLayer(service: CustodianShape): Layer.Layer<Custodian> {
	return Layer.succeed(Custodian, Custodian.of(service));
}
