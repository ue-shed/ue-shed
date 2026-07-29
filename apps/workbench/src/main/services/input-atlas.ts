import { EnhancedInputService, type EnhancedInputRunResult } from "@ue-shed/enhanced-input";
import { Context, Effect, Layer } from "effect";
import { ElectronDialog } from "../adapters/electron-dialog.js";
import type { WorkbenchWindowError } from "../adapters/electron-window.js";
import { WorkbenchConfiguration } from "../workbench-config.js";

export interface WorkbenchInputAtlasShape {
	readonly chooseAndScan: () => Effect.Effect<EnhancedInputRunResult, WorkbenchWindowError>;
	readonly configuredScan: () => Effect.Effect<EnhancedInputRunResult>;
}

export class WorkbenchInputAtlas extends Context.Service<
	WorkbenchInputAtlas,
	WorkbenchInputAtlasShape
>()("@ue-shed/workbench/WorkbenchInputAtlas") {}

export const WorkbenchInputAtlasLive = Layer.effect(
	WorkbenchInputAtlas,
	Effect.gen(function* () {
		const configuration = yield* WorkbenchConfiguration;
		const dialog = yield* ElectronDialog;
		const enhancedInput = yield* EnhancedInputService;

		const runScan = (projectRoot: string) =>
			enhancedInput.scan({ projectRoot }).pipe(
				Effect.map((report) => ({ report, status: "completed" as const })),
				Effect.catch((error) =>
					Effect.succeed({
						error: {
							code: error.code,
							message: error.message,
							recovery: error.recovery,
							retrySafe: error.retrySafe
						},
						status: "failed" as const
					})
				)
			);

		const configuredScan = Effect.fn("Workbench.WorkbenchInputAtlas.configuredScan")(
			function* () {
				if (configuration.project.status !== "configured") {
					return { status: "not_configured" as const };
				}
				return yield* runScan(configuration.project.projectRoot);
			}
		);

		const chooseAndScan = Effect.fn("Workbench.WorkbenchInputAtlas.chooseAndScan")(
			function* () {
				const choice = yield* dialog.chooseDirectory({
					title: "Choose an Unreal project for the Input Atlas"
				});
				if (choice.status === "cancelled") return { status: "cancelled" as const };
				return yield* runScan(choice.path);
			}
		);

		return WorkbenchInputAtlas.of({ chooseAndScan, configuredScan });
	})
);

export function makeWorkbenchInputAtlasTestLayer(
	service: WorkbenchInputAtlasShape
): Layer.Layer<WorkbenchInputAtlas> {
	return Layer.succeed(WorkbenchInputAtlas, WorkbenchInputAtlas.of(service));
}
