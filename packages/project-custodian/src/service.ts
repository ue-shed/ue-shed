import { Context, Effect, Layer, Ref, Schema } from "effect";
import {
	custodianProposalStorageIsValid,
	executeCustodianProposal,
	prepareCustodianProposal,
	readCustodianProposalDocument
} from "./node-executor.js";
import { scanCustodian } from "./node-scanner.js";
import {
	CustodianExecuteRequest,
	CustodianPrepareRequest,
	CustodianProposal,
	CustodianProposalId,
	CustodianScanRequest,
	decodeCustodianReceipt,
	decodeCustodianReport,
	type CustodianCancelResult,
	type CustodianReceipt,
	type CustodianReport
} from "./schema.js";

export class CustodianError extends Schema.TaggedErrorClass<CustodianError>()(
	"ProjectCustodian.Error",
	{
		code: Schema.Literals([
			"invalid_request",
			"scan_failed",
			"prepare_failed",
			"invalid_proposal",
			"execution_in_progress",
			"execution_failed"
		]),
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
	readonly prepare: (
		request: CustodianPrepareRequest
	) => Effect.Effect<CustodianProposal, CustodianError>;
	readonly execute: (
		request: CustodianExecuteRequest
	) => Effect.Effect<CustodianReceipt, CustodianError>;
	readonly cancel: (
		proposalId: CustodianProposalId
	) => Effect.Effect<CustodianCancelResult, CustodianError>;
}

export class Custodian extends Context.Service<Custodian, CustodianShape>()(
	"@ue-shed/project-custodian/Custodian"
) {}

function invalidRequest(operation: "scan" | "prepare" | "execute", cause: unknown) {
	return new CustodianError({
		code: "invalid_request",
		message: `The Project Custodian ${operation} request is invalid.`,
		recovery:
			operation === "scan"
				? "Provide one readable directory as the explicit scan root."
				: "Review the schema-owned request and retry without changing any target paths.",
		retrySafe: false,
		cause
	});
}

export const CustodianNodeLive = Layer.effect(
	Custodian,
	Effect.gen(function* () {
		const activeExecutions = yield* Ref.make<ReadonlyMap<CustodianProposalId, AbortController>>(
			new Map()
		);

		const scan = Effect.fn("ProjectCustodian.scan")(function* (input: CustodianScanRequest) {
			const request = yield* Schema.decodeUnknownEffect(CustodianScanRequest)(input).pipe(
				Effect.mapError((cause) => invalidRequest("scan", cause))
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

		const prepare = Effect.fn("ProjectCustodian.prepare")(function* (
			input: CustodianPrepareRequest
		) {
			const request = yield* Schema.decodeUnknownEffect(CustodianPrepareRequest)(input).pipe(
				Effect.mapError((cause) => invalidRequest("prepare", cause))
			);
			return yield* Effect.tryPromise({
				try: (signal) => prepareCustodianProposal(request, signal),
				catch: (cause) =>
					new CustodianError({
						code: "prepare_failed",
						message: "Project Custodian could not create a cleanup proposal.",
						recovery:
							"Rescan the root, select only targets in the current plan, and retry. No files were changed.",
						retrySafe: true,
						cause
					})
			});
		});

		const execute = Effect.fn("ProjectCustodian.execute")(function* (
			input: CustodianExecuteRequest
		) {
			const request = yield* Schema.decodeUnknownEffect(CustodianExecuteRequest)(input).pipe(
				Effect.mapError((cause) => invalidRequest("execute", cause))
			);
			const document = yield* Effect.tryPromise({
				try: () => readCustodianProposalDocument(request.proposalPath),
				catch: (cause) =>
					new CustodianError({
						code: "invalid_proposal",
						message: "Project Custodian could not read the cleanup proposal.",
						recovery:
							"Prepare a fresh proposal and review it before approving cleanup.",
						retrySafe: false,
						cause
					})
			});
			const proposal = yield* Schema.decodeUnknownEffect(CustodianProposal)(document).pipe(
				Effect.mapError(
					(cause) =>
						new CustodianError({
							code: "invalid_proposal",
							message: "Project Custodian rejected a malformed cleanup proposal.",
							recovery: "Prepare a fresh proposal and do not edit its JSON document.",
							retrySafe: false,
							cause
						})
				)
			);
			if (!custodianProposalStorageIsValid(proposal, request.proposalPath)) {
				return yield* Effect.fail(
					new CustodianError({
						code: "invalid_proposal",
						message: "Project Custodian rejected unsafe proposal storage paths.",
						recovery:
							"Prepare a fresh proposal and do not move or edit its JSON document.",
						retrySafe: false,
						cause: proposal
					})
				);
			}
			const controller = new AbortController();
			const acquired = yield* Ref.modify(activeExecutions, (current) => {
				if (current.has(proposal.id)) return [false, current] as const;
				const next = new Map(current);
				next.set(proposal.id, controller);
				return [true, next] as const;
			});
			if (!acquired) {
				return yield* Effect.fail(
					new CustodianError({
						code: "execution_in_progress",
						message: "This cleanup proposal is already executing.",
						recovery: "Wait for the active run or cancel its remaining targets.",
						retrySafe: true,
						cause: proposal.id
					})
				);
			}

			const cleanup = Effect.tryPromise({
				try: (signal) =>
					executeCustodianProposal(
						proposal,
						request.approvalPhrase,
						AbortSignal.any([signal, controller.signal])
					),
				catch: (cause) =>
					new CustodianError({
						code: "execution_failed",
						message: "Project Custodian could not finish the cleanup operation.",
						recovery:
							"Inspect the proposal event log and receipt, then rescan before retrying any remaining targets.",
						retrySafe: false,
						cause
					})
			}).pipe(
				Effect.flatMap(decodeCustodianReceipt),
				Effect.mapError((cause) =>
					cause instanceof CustodianError
						? cause
						: new CustodianError({
								code: "execution_failed",
								message: "Project Custodian produced an invalid cleanup receipt.",
								recovery:
									"Inspect the event log and rescan before retrying any remaining targets.",
								retrySafe: false,
								cause
							})
				),
				Effect.ensuring(
					Ref.update(activeExecutions, (current) => {
						const next = new Map(current);
						next.delete(proposal.id);
						return next;
					})
				)
			);
			return yield* cleanup;
		});

		const cancel = Effect.fn("ProjectCustodian.cancel")(function* (
			proposalId: CustodianProposalId
		) {
			const decodedId = yield* Schema.decodeUnknownEffect(CustodianProposalId)(
				proposalId
			).pipe(Effect.mapError((cause) => invalidRequest("execute", cause)));
			const active = (yield* Ref.get(activeExecutions)).get(decodedId);
			if (active === undefined) {
				return { proposalId: decodedId, status: "not_running" as const };
			}
			active.abort(new Error("Cleanup cancelled by the user."));
			return { proposalId: decodedId, status: "cancelled" as const };
		});

		return Custodian.of({ scan, prepare, execute, cancel });
	})
);

export function makeCustodianTestLayer(service: CustodianShape): Layer.Layer<Custodian> {
	return Layer.succeed(Custodian, Custodian.of(service));
}
