import {
	CustodianClientError,
	decodeCustodianRunResult,
	type CustodianClientShape
} from "@ue-shed/extension-project-custodian";
import { Effect } from "effect";

function request(options: { readonly invoke: () => Promise<unknown>; readonly operation: string }) {
	return Effect.tryPromise({
		try: options.invoke,
		catch: (cause) =>
			new CustodianClientError({
				cause,
				operation: options.operation,
				recovery: "Restart Workbench and retry. No files were changed."
			})
	}).pipe(
		Effect.flatMap(decodeCustodianRunResult),
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

export const projectCustodianClient: CustodianClientShape = {
	configuredScan: Effect.fn("ProjectCustodianClient.configuredScan")(() =>
		request({
			invoke: () => window.ueShed.projectCustodian.configuredScan(),
			operation: "projectCustodian.configuredScan"
		})
	),
	chooseAndScan: Effect.fn("ProjectCustodianClient.chooseAndScan")(() =>
		request({
			invoke: () => window.ueShed.projectCustodian.chooseAndScan(),
			operation: "projectCustodian.chooseAndScan"
		})
	)
};
