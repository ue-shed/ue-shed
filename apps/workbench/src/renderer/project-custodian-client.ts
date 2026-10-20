import {
	CustodianClientError,
	parseCustodianCancelRunResult,
	parseCustodianExecutionRunResult,
	parseCustodianPrepareRunResult,
	parseCustodianRunResult,
	type CustodianClientApi
} from "@ue-shed/extension-project-custodian/client";
import { Effect } from "effect";

function request<A, HostValue, DecodeError>(
	options: {
		readonly invoke: () => Promise<HostValue>;
		readonly operation: string;
		/** The operation deletes or moves project files, so a lost reply leaves its outcome unknown. */
		readonly changesFiles?: true;
	},
	decode: (value: HostValue) => Effect.Effect<A, DecodeError>
) {
	const unknownOutcome = options.changesFiles
		? " The cleanup may have run: check the project files before running it again."
		: " No files were changed.";
	return Effect.tryPromise({
		try: options.invoke,
		catch: (cause) =>
			new CustodianClientError({
				message: "Project Custodian could not complete the host operation.",
				retrySafe: false,
				nextStep: "reconcile",
				code: "custodian_client_failed",
				cause,
				operation: options.operation,
				recovery: `Restart Workbench, then retry.${unknownOutcome}`
			})
	}).pipe(
		Effect.flatMap(decode),
		Effect.mapError(
			(cause) =>
				new CustodianClientError({
					message: "Project Custodian could not complete the host operation.",
					retrySafe: false,
					nextStep: "reconcile",
					code: "custodian_client_failed",
					cause,
					operation: options.operation,
					recovery: `Update paired UE Shed packages, then retry.${unknownOutcome}`
				})
		)
	);
}

export const projectCustodianClient: CustodianClientApi = {
	configuredScan: Effect.fn("ProjectCustodianClient.configuredScan")(() =>
		request(
			{
				invoke: () => window.ueShed.projectCustodian.configuredScan(),
				operation: "projectCustodian.configuredScan"
			},
			parseCustodianRunResult
		)
	),
	prepare: Effect.fn("ProjectCustodianClient.prepare")((intent) =>
		request(
			{
				invoke: () => window.ueShed.projectCustodian.prepare(intent),
				operation: "projectCustodian.prepare"
			},
			parseCustodianPrepareRunResult
		)
	),
	execute: Effect.fn("ProjectCustodianClient.execute")((intent) =>
		request(
			{
				invoke: () => window.ueShed.projectCustodian.execute(intent),
				operation: "projectCustodian.execute",
				changesFiles: true
			},
			parseCustodianExecutionRunResult
		)
	),
	cancel: Effect.fn("ProjectCustodianClient.cancel")((proposalId) =>
		request(
			{
				invoke: () => window.ueShed.projectCustodian.cancel(proposalId),
				operation: "projectCustodian.cancel"
			},
			parseCustodianCancelRunResult
		)
	)
};
