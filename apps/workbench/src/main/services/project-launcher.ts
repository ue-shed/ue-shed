import { Context, Effect, Layer } from "effect";
import { join } from "node:path";
import { FixtureProcess } from "../adapters/fixture-process.js";
import { LocalFiles } from "../adapters/local-files.js";
import type { ProjectLaunchMode, ProjectLaunchResult } from "../project-workspace-contract.js";
import { WorkbenchConfiguration } from "../workbench-config.js";
import { WorkbenchProject } from "./project-workspace.js";

export interface ProjectLauncherShape {
	readonly launch: (mode: ProjectLaunchMode) => Effect.Effect<ProjectLaunchResult>;
}

export class ProjectLauncher extends Context.Service<ProjectLauncher, ProjectLauncherShape>()(
	"@ue-shed/workbench/ProjectLauncher"
) {}

const noSelectedProject: ProjectLaunchResult = {
	status: "failed",
	message: "No project is selected.",
	recovery: "Choose a project first. Project selection and indexing remain offline."
};

const noLauncher: ProjectLaunchResult = {
	status: "failed",
	message: "This Workbench build has no selected-project launcher.",
	recovery: "Start Workbench from a UE Shed source checkout."
};

export const ProjectLauncherLive = Layer.effect(
	ProjectLauncher,
	Effect.gen(function* () {
		const configuration = yield* WorkbenchConfiguration;
		const files = yield* LocalFiles;
		const processHost = yield* FixtureProcess;
		const project = yield* WorkbenchProject;

		const launch = Effect.fn("Workbench.ProjectLauncher.launch")(function* (
			mode: ProjectLaunchMode
		) {
			const selected = yield* project.current();
			if (selected.status !== "ready") return noSelectedProject;
			if (configuration.sourceCheckout.status !== "configured") return noLauncher;

			const cwd = configuration.sourceCheckout.path;
			const script = join(cwd, "scripts", "unreal-project.ts");
			if (!(yield* files.exists(script))) return noLauncher;

			return yield* Effect.scoped(
				processHost
					.launch({
						args: [
							script,
							"launch",
							"--project",
							selected.project.projectRoot,
							"--mode",
							mode
						],
						cwd,
						...(configuration.unrealEngineRoot?.status === "configured"
							? {
									env: {
										UE_SHED_UNREAL_ENGINE_ROOT:
											configuration.unrealEngineRoot.path
									}
								}
							: {}),
						executable: process.execPath
					})
					.pipe(
						Effect.map(
							(result): ProjectLaunchResult =>
								result.status === "ready"
									? { mode, status: "launched" }
									: {
											status: "failed",
											message: result.message,
											recovery:
												mode === "ue_shed"
													? "Review the launcher error. If Unreal Build Tool ran, check its log, then retry or launch normally."
													: "Verify the selected project's Unreal installation, then retry."
										}
						),
						Effect.catch((error) =>
							Effect.succeed({
								status: "failed" as const,
								message: error.message,
								recovery: error.recovery
							})
						)
					)
			);
		});

		return ProjectLauncher.of({ launch });
	})
);

export function makeProjectLauncherTestLayer(
	service: ProjectLauncherShape
): Layer.Layer<ProjectLauncher> {
	return Layer.succeed(ProjectLauncher, ProjectLauncher.of(service));
}
