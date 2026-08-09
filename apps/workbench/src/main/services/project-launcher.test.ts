import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { join } from "node:path";
import { expect } from "vitest";
import { FixtureProcessTest, makeFixtureProcessTestLayer } from "../adapters/fixture-process.js";
import { makeLocalFilesTestLayer } from "../adapters/local-files.js";
import { workbenchConfigurationFromUnknown } from "../workbench-config.js";
import { ProjectLauncher, ProjectLauncherLive } from "./project-launcher.js";
import { makeWorkbenchProjectTestLayer } from "./project-workspace.js";

const repositoryRoot = "C:/ue-shed";
const script = join(repositoryRoot, "scripts", "unreal-project.mjs");
const selected = {
	project: {
		inputAtlas: "ready" as const,
		mapCount: 2,
		packageCount: 12,
		projectName: "Hex",
		projectRoot: "D:/Projects/Hex"
	},
	status: "ready" as const
};

function projectLayer(state: typeof selected | { readonly status: "not_configured" }) {
	return makeWorkbenchProjectTestLayer({
		choose: () => Effect.succeed(state),
		current: () => Effect.succeed(state),
		inputAtlas: () => Effect.die("not used"),
		savedProject: () => Effect.die("not used"),
		savedTables: () => Effect.die("not used")
	});
}

function launcherLayer(state: typeof selected | { readonly status: "not_configured" } = selected) {
	const dependencies = Layer.mergeAll(
		projectLayer(state),
		makeFixtureProcessTestLayer(),
		makeLocalFilesTestLayer(new Map([[script, new Uint8Array([1])]])),
		workbenchConfigurationFromUnknown({
			UE_SHED_REPOSITORY_ROOT: repositoryRoot,
			UE_SHED_REMOTE_CONTROL_ENDPOINT: "http://127.0.0.1:30001",
			UE_SHED_UNREAL_ENGINE_ROOT: "C:/Epic/UE_5.7"
		})
	);
	return Layer.merge(dependencies, ProjectLauncherLive.pipe(Layer.provide(dependencies)));
}

it.effect("launches the selected project with an explicit UE Shed mode", () =>
	Effect.gen(function* () {
		const launcher = yield* ProjectLauncher;
		const processHost = yield* FixtureProcessTest;

		expect(yield* launcher.launch("ue_shed")).toEqual({
			mode: "ue_shed",
			status: "launched"
		});
		const launches = yield* processHost.launches();
		expect(launches).toHaveLength(1);
		expect(launches[0]?.args).toEqual([
			script,
			"launch",
			"--project",
			"D:/Projects/Hex",
			"--mode",
			"ue_shed"
		]);
		expect(launches[0]?.env).toEqual({
			UE_SHED_UNREAL_ENGINE_ROOT: "C:/Epic/UE_5.7"
		});
	}).pipe(Effect.provide(launcherLayer()))
);

it.effect("does not launch anything before a project is selected", () =>
	Effect.gen(function* () {
		const launcher = yield* ProjectLauncher;
		const processHost = yield* FixtureProcessTest;
		const result = yield* launcher.launch("normal");

		expect(result.status).toBe("failed");
		expect(yield* processHost.launches()).toEqual([]);
	}).pipe(Effect.provide(launcherLayer({ status: "not_configured" })))
);
