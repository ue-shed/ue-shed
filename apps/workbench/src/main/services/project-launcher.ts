import { Context, Effect, Layer, Schema } from "effect";
import { join } from "node:path";
import { FixtureProcess } from "../adapters/fixture-process.js";
import { LocalFiles } from "../adapters/local-files.js";
import type { ProjectLaunchMode, ProjectLaunchResult } from "../project-workspace-contract.js";
import { ProjectLaunchFailure } from "../project-workspace-contract.js";
import { typescriptCheckoutArgs } from "../typescript-checkout.js";
import { WorkbenchConfiguration } from "../workbench-config.js";
import { WorkbenchProject } from "./project-workspace.js";

export interface ProjectLauncherApi {
	readonly launch: (mode: ProjectLaunchMode) => Effect.Effect<ProjectLaunchResult>;
}

export class ProjectLauncher extends Context.Service<ProjectLauncher, ProjectLauncherApi>()(
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

export function projectLaunchFailure(stderr: string): typeof ProjectLaunchFailure.Type {
	const prefix = "UE_SHED_LAUNCH_FAILURE_V1 ";
	const line = stderr.split(/\r?\n/u).find((value) => value.startsWith(prefix));
	if (line) {
		try {
			return Schema.decodeUnknownSync(ProjectLaunchFailure)(
				JSON.parse(line.slice(prefix.length))
			);
		} catch {
			/* Retain malformed diagnostics for troubleshooting. */
		}
	}
	if (stderr.includes("FailedDueToEngineChange")) {
		return {
			status: "failed",
			message: "Plugin compilation would modify your existing Unreal engine build.",
			recovery:
				"UE Shed stopped the build to preserve your engine. Review the affected files in the build output before rebuilding the engine.",
			details: stderr
		};
	}
	return {
		status: "failed",
		message: "Unreal could not be launched.",
		recovery:
			"Review the technical details below for the build or startup failure, then retry.",
		details: stderr
	};
}

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
						args: typescriptCheckoutArgs(script, [
							"launch",
							"--project",
							selected.project.projectRoot,
							"--mode",
							mode
						]),
						cwd,
						...(configuration.unrealEngineRoot?.status === "configured"
							? {
									env: {
										UE_SHED_UNREAL_ENGINE_ROOT:
											configuration.unrealEngineRoot.path
									}
								}
							: undefined),
						executable: process.execPath
					})
					.pipe(
						Effect.map(
							(result): ProjectLaunchResult =>
								result.status === "ready"
									? { mode, status: "launched" }
									: projectLaunchFailure(result.message)
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
	service: ProjectLauncherApi
): Layer.Layer<ProjectLauncher> {
	return Layer.succeed(ProjectLauncher, ProjectLauncher.of(service));
}
