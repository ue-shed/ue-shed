import type { CustodianRunResult } from "@ue-shed/extension-project-custodian/client";
import { Custodian } from "@ue-shed/project-custodian";
import { Context, Effect, Layer, Ref } from "effect";
import { ElectronDialog } from "../adapters/electron-dialog.js";
import { WorkbenchConfiguration } from "../workbench-config.js";

export interface WorkbenchCustodianShape {
	readonly chooseAndScan: () => Effect.Effect<CustodianRunResult>;
	readonly configuredScan: () => Effect.Effect<CustodianRunResult>;
}

export class WorkbenchCustodian extends Context.Service<
	WorkbenchCustodian,
	WorkbenchCustodianShape
>()("@ue-shed/workbench/WorkbenchCustodian") {}

export const WorkbenchCustodianLive = Layer.effect(
	WorkbenchCustodian,
	Effect.gen(function* () {
		const configuration = yield* WorkbenchConfiguration;
		const custodian = yield* Custodian;
		const dialog = yield* ElectronDialog;
		const root = yield* Ref.make<string | undefined>(
			configuration.project.status === "configured"
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

		return WorkbenchCustodian.of({ chooseAndScan, configuredScan });
	})
);

export function makeWorkbenchCustodianTestLayer(
	service: WorkbenchCustodianShape
): Layer.Layer<WorkbenchCustodian> {
	return Layer.succeed(WorkbenchCustodian, WorkbenchCustodian.of(service));
}
