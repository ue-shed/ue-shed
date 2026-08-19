import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "@effect/vitest";
import { Effect, Layer, Ref } from "effect";
import { expect } from "vitest";
import { makeEngineInstallationDiscoveryTestLayer } from "./engine-installation.js";
import {
	UnrealProjectLauncher,
	UnrealProjectLauncherLive,
	makeUnrealProjectProcessTestLayer,
	unrealEditorCommandletExecutable,
	unrealProjectLaunchArguments,
	type UnrealProjectProcessLaunchOptions
} from "./project-launcher.js";

it("resolves platform commandlet executable paths", () => {
	expect(unrealEditorCommandletExecutable("C:/UE", "win32")).toBe(
		join("C:/UE", "Engine", "Binaries", "Win64", "UnrealEditor-Cmd.exe")
	);
	expect(unrealEditorCommandletExecutable("/UE", "linux")).toBe(
		join("/UE", "Engine", "Binaries", "Linux", "UnrealEditor-Cmd")
	);
});

it("builds normal and plugin launch arguments without a shell", () => {
	expect(
		unrealProjectLaunchArguments({
			mode: { kind: "normal" },
			projectDescriptor: "D:/Projects/Hex/Hex.uproject"
		})
	).toEqual([resolve("D:/Projects/Hex/Hex.uproject")]);

	const args = unrealProjectLaunchArguments({
		mode: {
			kind: "with_plugins",
			plugins: [{ descriptor: "C:/Plugins/UEShedCore.uplugin", id: "UEShedCore" }],
			remoteControlHttpPort: 30_001
		},
		projectDescriptor: "D:/Projects/Hex/Hex.uproject"
	});
	expect(args).toContain(`-PLUGIN=${resolve("C:/Plugins/UEShedCore.uplugin")}`);
	expect(args).toContain("-EnablePlugins=UEShedCore,RemoteControl");
	expect(args).toContain(
		"-ini:RemoteControl:[/Script/RemoteControlCommon.RemoteControlSettings]:RemoteControlHttpServerPort=30001"
	);
});

it.effect("resolves the engine and launches through the supplied process adapter", () =>
	Effect.gen(function* () {
		const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "ue-shed-engine-launch-")));
		const executable = join(
			root,
			"Engine",
			"Binaries",
			process.platform === "win32"
				? "Win64"
				: process.platform === "darwin"
					? "Mac"
					: "Linux",
			process.platform === "win32" ? "UnrealEditor.exe" : "UnrealEditor"
		);
		const projectDescriptor = join(root, "Fixture.uproject");
		yield* Effect.promise(() => mkdir(join(executable, ".."), { recursive: true }));
		yield* Effect.promise(() => writeFile(executable, ""));
		yield* Effect.promise(() => writeFile(projectDescriptor, "{}"));
		const launches = yield* Ref.make<readonly UnrealProjectProcessLaunchOptions[]>([]);
		const dependencies = Layer.merge(
			makeEngineInstallationDiscoveryTestLayer(() =>
				Effect.succeed({ root, version: { major: 5, minor: 7, patch: 0 } })
			),
			makeUnrealProjectProcessTestLayer((options) =>
				Ref.update(launches, (current) => [...current, options]).pipe(Effect.as(42))
			)
		);
		const layer = UnrealProjectLauncherLive.pipe(Layer.provide(dependencies));
		const result = yield* Effect.flatMap(UnrealProjectLauncher, (launcher) =>
			launcher.launch({ mode: { kind: "normal" }, projectDescriptor })
		).pipe(Effect.provide(layer));
		expect(result).toMatchObject({ mode: "normal", pid: 42, projectDescriptor });
		expect(yield* Ref.get(launches)).toEqual([
			{ args: [projectDescriptor], cwd: root, executable }
		]);
		yield* Effect.promise(() => rm(root, { force: true, recursive: true }));
	})
);
