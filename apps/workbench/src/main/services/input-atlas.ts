import type { EnhancedInputRunResult } from "@ue-shed/enhanced-input";
import { Context, Effect, Layer } from "effect";
import { WorkbenchProject } from "./project-workspace.js";

export interface WorkbenchInputAtlasApi {
	readonly chooseAndScan: () => Effect.Effect<EnhancedInputRunResult>;
	readonly configuredScan: () => Effect.Effect<EnhancedInputRunResult>;
}

export class WorkbenchInputAtlas extends Context.Service<
	WorkbenchInputAtlas,
	WorkbenchInputAtlasApi
>()("@ue-shed/workbench/WorkbenchInputAtlas") {}

export const WorkbenchInputAtlasLive = Layer.effect(
	WorkbenchInputAtlas,
	Effect.gen(function* () {
		const project = yield* WorkbenchProject;

		const configuredScan = Effect.fn("Workbench.WorkbenchInputAtlas.configuredScan")(
			function* () {
				return yield* project.inputAtlas();
			}
		);

		const chooseAndScan = Effect.fn("Workbench.WorkbenchInputAtlas.chooseAndScan")(
			function* () {
				const choice = yield* project.choose();
				if (choice.status === "cancelled") return { status: "cancelled" as const };
				if (choice.status === "failed") {
					return {
						error: {
							code: "invalid_project" as const,
							message: choice.error.message,
							recovery: choice.error.recovery,
							retrySafe: true
						},
						status: "failed" as const
					};
				}
				return yield* project.inputAtlas();
			}
		);

		return WorkbenchInputAtlas.of({ chooseAndScan, configuredScan });
	})
);

export function makeWorkbenchInputAtlasTestLayer(
	service: WorkbenchInputAtlasApi
): Layer.Layer<WorkbenchInputAtlas> {
	return Layer.succeed(WorkbenchInputAtlas, WorkbenchInputAtlas.of(service));
}
