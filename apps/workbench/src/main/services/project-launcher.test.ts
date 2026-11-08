import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { join } from "node:path";
import { expect } from "vitest";
import { FixtureProcessTest, makeFixtureProcessTestLayer } from "../adapters/fixture-process.js";
import { makeLocalFilesTestLayer } from "../adapters/local-files.js";
import { typescriptLoader } from "../typescript-checkout.js";
import { workbenchConfigurationFromUnknown } from "../workbench-config.js";
import { ProjectLauncher, ProjectLauncherLive, projectLaunchFailure } from "./project-launcher.js";
import { makeWorkbenchProjectTestLayer } from "./project-workspace.js";

const repositoryRoot = "C:/ue-shed";
const script = join(repositoryRoot, "scripts", "unreal-project.ts");

it("preserves actionable launch failures and keeps raw stderr in details", () => {
	const failure = {
		status: "failed",
		message: "Project modules need rebuilding.",
		recovery: "Build the Editor target.",
		details: "Engine: C:/UE\nBuild ID: custom"
	};
	expect(
		projectLaunchFailure("warning\nUE_SHED_LAUNCH_FAILURE_V1 " + JSON.stringify(failure) + "\n")
	).toEqual(failure);
	const fallback = projectLaunchFailure(
		"Unhandled stack trace\nUE_SHED_LAUNCH_FAILURE_V1 invalid"
	);
	expect(fallback.message).toBe("Unreal could not be launched.");
	expect(fallback.details).toContain("Unhandled stack trace");
});
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
		choose: Effect.sync(() => state),
		current: Effect.sync(() => state),
		inputAtlas: Effect.suspend(() => Effect.die("not used")),
		savedProject: Effect.suspend(() => Effect.die("not used")),
		savedTables: Effect.suspend(() => Effect.die("not used"))
	});
}

function launcherLayer(
	state: typeof selected | { readonly status: "not_configured" } = selected,
	behavior?: Parameters<typeof makeFixtureProcessTestLayer>[0]
) {
	const dependencies = Layer.mergeAll(
		projectLayer(state),
		makeFixtureProcessTestLayer(behavior),
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
		const launches = yield* processHost.launches;
		expect(launches).toHaveLength(1);
		expect(launches[0]?.args).toEqual([
			"--import",
			typescriptLoader,
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
		expect(yield* processHost.launches).toEqual([]);
	}).pipe(Effect.provide(launcherLayer({ status: "not_configured" })))
);

it("explains engine-change refusal without hiding the build output", () => {
	const output = "Building would modify engine files.\nResult: Failed (FailedDueToEngineChange)";
	const failure = projectLaunchFailure(output);
	expect(failure.message).toContain("existing Unreal engine build");
	expect(failure.details).toBe(output);
});

it.effect("L11.8 shares concurrent launches and permits a later retry", () =>
	Effect.gen(function* () {
		const started = yield* Deferred.make<void>();
		const release = yield* Deferred.make<void>();
		yield* Effect.gen(function* () {
			const launcher = yield* ProjectLauncher;
			const process = yield* FixtureProcessTest;
			const first = yield* launcher.launch("ue_shed").pipe(Effect.forkChild);
			yield* Deferred.await(started);
			const second = yield* launcher.launch("ue_shed").pipe(Effect.forkChild);
			for (let i = 0; i < 20; i++) yield* Effect.yieldNow;
			yield* Deferred.succeed(release, undefined);
			expect(yield* Fiber.join(first)).toEqual(yield* Fiber.join(second));
			expect(yield* process.launches).toHaveLength(1);
			yield* launcher.launch("ue_shed");
			expect(yield* process.launches).toHaveLength(2);
		}).pipe(
			Effect.provide(
				launcherLayer(selected, () =>
					Deferred.succeed(started, undefined).pipe(
						Effect.andThen(Deferred.await(release)),
						Effect.as({ status: "ready" as const })
					)
				)
			)
		);
	})
);
