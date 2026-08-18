import type {
	CustodianCancelRunResult,
	CustodianExecutionRunResult,
	CustodianPrepareIntent,
	CustodianPrepareRunResult,
	CustodianRunResult
} from "@ue-shed/extension-project-custodian/client";
import {
	Custodian,
	type CustodianExecuteRequest,
	type CustodianProposalId
} from "@ue-shed/project-custodian";
import { join } from "node:path";
import { Context, Effect, Layer, Ref } from "effect";
import { ElectronApp } from "../adapters/electron-app.js";
import { ElectronDialog } from "../adapters/electron-dialog.js";
import { WorkbenchConfiguration } from "../workbench-config.js";

export interface WorkbenchCustodianApi {
	readonly chooseAndScan: () => Effect.Effect<CustodianRunResult>;
	readonly configuredScan: () => Effect.Effect<CustodianRunResult>;
	readonly prepare: (intent: CustodianPrepareIntent) => Effect.Effect<CustodianPrepareRunResult>;
	readonly execute: (
		intent: CustodianExecuteRequest
	) => Effect.Effect<CustodianExecutionRunResult>;
	readonly cancel: (proposalId: CustodianProposalId) => Effect.Effect<CustodianCancelRunResult>;
}

export class WorkbenchCustodian extends Context.Service<
	WorkbenchCustodian,
	WorkbenchCustodianApi
>()("@ue-shed/workbench/WorkbenchCustodian") {}

export const WorkbenchCustodianLive = Layer.effect(
	WorkbenchCustodian,
	Effect.gen(function* () {
		const configuration = yield* WorkbenchConfiguration;
		const custodian = yield* Custodian;
		const dialog = yield* ElectronDialog;
		const electronApp = yield* ElectronApp;
		const root = yield* Ref.make<string | undefined>(
			configuration.custodianRoot?.status === "configured"
				? configuration.custodianRoot.path
				: configuration.project.status === "configured"
					? configuration.project.projectRoot
					: undefined
		);

		const scan = Effect.fn("Workbench.ProjectCustodian.scan")(function* (scanRoot: string) {
			return yield* custodian.scan({ root: scanRoot }).pipe(
				Effect.map((report) => ({ status: "completed" as const, report })),
				Effect.catch((error) =>
					Effect.succeed({
						status: "failed" as const,
						error: {
							code: "scan_failed" as const,
							message: error.message,
							recovery: error.recovery,
							retrySafe: error.retrySafe
						}
					})
				)
			);
		});

		const configuredScan = Effect.fn("Workbench.ProjectCustodian.configuredScan")(function* () {
			const configured = yield* Ref.get(root);
			return configured === undefined
				? ({ status: "not_configured" } as const)
				: yield* scan(configured);
		});

		const chooseAndScan = Effect.fn("Workbench.ProjectCustodian.chooseAndScan")(function* () {
			const selected = yield* Effect.result(
				dialog.chooseDirectory({ title: "Choose a Project Custodian scan root" })
			);
			if (selected._tag === "Failure") {
				return {
					status: "failed" as const,
					error: {
						code: "dialog_failed" as const,
						message: selected.failure.message,
						recovery: selected.failure.recovery,
						retrySafe: selected.failure.retrySafe
					}
				};
			}
			const choice = selected.success;
			if (choice.status === "cancelled") return { status: "cancelled" as const };
			yield* Ref.set(root, choice.path);
			return yield* scan(choice.path);
		});

		const prepare = Effect.fn("Workbench.ProjectCustodian.prepare")(function* (
			intent: CustodianPrepareIntent
		) {
			return yield* Effect.gen(function* () {
				const userData = yield* electronApp.getPath("userData");
				const proposal = yield* custodian.prepare({
					...intent,
					proposalDirectory: join(userData, "custodian")
				});
				return { status: "completed" as const, proposal };
			}).pipe(
				Effect.catch((error) =>
					Effect.succeed({
						status: "failed" as const,
						error: {
							code: "prepare_failed" as const,
							message: error.message,
							recovery: error.recovery,
							retrySafe: error.retrySafe
						}
					})
				)
			);
		});

		const execute = Effect.fn("Workbench.ProjectCustodian.execute")(function* (
			intent: CustodianExecuteRequest
		) {
			return yield* custodian.execute(intent).pipe(
				Effect.map((receipt) => ({ status: "completed" as const, receipt })),
				Effect.catch((error) =>
					Effect.succeed({
						status: "failed" as const,
						error: {
							code: "execution_failed" as const,
							message: error.message,
							recovery: error.recovery,
							retrySafe: error.retrySafe
						}
					})
				)
			);
		});

		const cancel = Effect.fn("Workbench.ProjectCustodian.cancel")(function* (
			proposalId: CustodianProposalId
		) {
			return yield* custodian.cancel(proposalId).pipe(
				Effect.map((result) => ({ status: "completed" as const, result })),
				Effect.catch((error) =>
					Effect.succeed({
						status: "failed" as const,
						error: {
							code: "execution_failed" as const,
							message: error.message,
							recovery: error.recovery,
							retrySafe: error.retrySafe
						}
					})
				)
			);
		});

		return WorkbenchCustodian.of({ chooseAndScan, configuredScan, prepare, execute, cancel });
	})
);

export function makeWorkbenchCustodianTestLayer(
	service: WorkbenchCustodianApi
): Layer.Layer<WorkbenchCustodian> {
	return Layer.succeed(WorkbenchCustodian, WorkbenchCustodian.of(service));
}
