import {
	CustodianClientError,
	decodeCustodianCancelRunResult,
	decodeCustodianExecutionRunResult,
	decodeCustodianPrepareRunResult,
	decodeCustodianRunResult,
	type CustodianClientApi
} from "@ue-shed/extension-project-custodian";
import { Effect } from "effect";

function request<A, HostValue, DecodeError>(
	options: { readonly invoke: () => Promise<HostValue>; readonly operation: string },
	decode: (value: HostValue) => Effect.Effect<A, DecodeError>
) {
	return Effect.tryPromise({
		try: options.invoke,
		catch: (cause) =>
			new CustodianClientError({
				cause,
				operation: options.operation,
				recovery: "Restart Workbench and retry. No files were changed."
			})
	}).pipe(
		Effect.flatMap(decode),
		Effect.mapError(
			(cause) =>
				new CustodianClientError({
					cause,
					operation: options.operation,
					recovery: "Update paired UE Shed packages and retry. No files were changed."
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
			decodeCustodianRunResult
		)
	),
	chooseAndScan: Effect.fn("ProjectCustodianClient.chooseAndScan")(() =>
		request(
			{
				invoke: () => window.ueShed.projectCustodian.chooseAndScan(),
				operation: "projectCustodian.chooseAndScan"
			},
			decodeCustodianRunResult
		)
	),
	prepare: Effect.fn("ProjectCustodianClient.prepare")((intent) =>
		request(
			{
				invoke: () => window.ueShed.projectCustodian.prepare(intent),
				operation: "projectCustodian.prepare"
			},
			decodeCustodianPrepareRunResult
		)
	),
	execute: Effect.fn("ProjectCustodianClient.execute")((intent) =>
		request(
			{
				invoke: () => window.ueShed.projectCustodian.execute(intent),
				operation: "projectCustodian.execute"
			},
			decodeCustodianExecutionRunResult
		)
	),
	cancel: Effect.fn("ProjectCustodianClient.cancel")((proposalId) =>
		request(
			{
				invoke: () => window.ueShed.projectCustodian.cancel(proposalId),
				operation: "projectCustodian.cancel"
			},
			decodeCustodianCancelRunResult
		)
	)
};
