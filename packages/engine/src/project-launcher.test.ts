import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "@effect/vitest";
import { Effect, Layer, Ref } from "effect";
import { expect } from "vitest";
import { unrealRemoteControlPermissions } from "./remote-control-permissions.js";
import { makeEngineInstallationDiscoveryTestLayer } from "./engine-installation.js";
import {
	UnrealProjectLauncher,
	UnrealProjectLauncherLive,
	makeUnrealProjectProcessTestLayer,
	unrealEditorCommandletExecutable,
	unrealProjectLaunchArguments,
	validateUnrealProjectBuildId,
	validateUnrealRemoteControlBuild,
	type UnrealProjectProcessLaunchOptions
} from "./project-launcher.js";

it("rejects different builds of the same engine before launch and accepts matching identities", async () => {
	const root = await mkdtemp(join(tmpdir(), "ue-shed-build-identity-"));
	try {
		const engine = join(root, "engine");
		const project = join(root, "project", "Fixture.uproject");
		const engineBin = join(engine, "Engine", "Binaries", "Win64");
		const projectBin = join(root, "project", "Binaries", "Win64");
		await mkdir(engineBin, { recursive: true });
		await mkdir(projectBin, { recursive: true });
		await writeFile(
			join(engineBin, "UnrealEditor.modules"),
			JSON.stringify({ BuildId: "custom-build-a" })
		);
		await writeFile(
			join(projectBin, "UnrealEditor.modules"),
			JSON.stringify({ BuildId: "custom-build-b" })
		);
		const result = await Effect.runPromise(
			Effect.result(validateUnrealProjectBuildId(engine, project, "win32"))
		);
		expect(result).toMatchObject({ _tag: "Failure", failure: { code: "build_mismatch" } });
		await writeFile(
			join(projectBin, "UnrealEditor.modules"),
			JSON.stringify({ BuildId: "custom-build-a" })
		);
		await Effect.runPromise(validateUnrealProjectBuildId(engine, project, "win32"));
		await rm(join(projectBin, "UnrealEditor.modules"));
		await Effect.runPromise(validateUnrealProjectBuildId(engine, project, "win32"));
		await writeFile(join(projectBin, "UnrealEditor.modules"), "not-json");
		const invalid = await Effect.runPromise(
			Effect.result(validateUnrealProjectBuildId(engine, project, "win32"))
		);
		expect(invalid).toMatchObject({
			_tag: "Failure",
			failure: { code: "invalid_module_manifest" }
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it("resolves platform commandlet executable paths", () => {
	expect(unrealEditorCommandletExecutable("C:/UE", "win32")).toBe(
		join("C:/UE", "Engine", "Binaries", "Win64", "UnrealEditor-Cmd.exe")
	);
	expect(unrealEditorCommandletExecutable("/UE", "linux")).toBe(
		join("/UE", "Engine", "Binaries", "Linux", "UnrealEditor-Cmd")
	);
});

it("allows only enabled UE Shed API classes without opening arbitrary remote calls", () => {
	const rules = unrealRemoteControlPermissions([
		"UEShedCameraAuthoringBridge",
		"UEShedCameraAuthoringBridge",
		"Unknown",
		"__proto__"
	]);
	expect(rules).toEqual([
		"-ini:RemoteControl:[/Script/RemoteControlCommon.RemoteControlSettings]:+CustomAllowedRemoteFunctionCalls=(ClassPath=/Script/UEShedCameraAuthoringBridge.UEShedCameraAuthoringBridgeLibrary,bAllowChildClasses=False)"
	]);
	expect(unrealRemoteControlPermissions([])).toEqual([]);
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
		const projectBinaries = join(
			root,
			"Binaries",
			process.platform === "win32" ? "Win64" : process.platform === "darwin" ? "Mac" : "Linux"
		);
		yield* Effect.promise(async () => {
			await mkdir(projectBinaries, { recursive: true });
			await writeFile(
				join(executable, "..", "UnrealEditor.modules"),
				JSON.stringify({ BuildId: "engine-build" })
			);
			await writeFile(
				join(projectBinaries, "UnrealEditor.modules"),
				JSON.stringify({ BuildId: "project-build" })
			);
		});
		const refused = yield* Effect.flatMap(UnrealProjectLauncher, (launcher) =>
			launcher.launch({ mode: { kind: "normal" }, projectDescriptor })
		).pipe(Effect.provide(layer), Effect.result);
		expect(refused).toMatchObject({ _tag: "Failure", failure: { code: "build_mismatch" } });
		expect(yield* Ref.get(launches)).toHaveLength(1);
		yield* Effect.promise(() => rm(root, { force: true, recursive: true }));
	})
);

it("validates Remote Control dependencies, identities and DLLs before launch", async () => {
	const root = await mkdtemp(join(tmpdir(), "ue-shed-remote-build-"));
	try {
		const engineBin = join(root, "Engine", "Binaries", "Win64");
		await mkdir(engineBin, { recursive: true });
		await writeFile(
			join(engineBin, "UnrealEditor.modules"),
			JSON.stringify({ BuildId: "current" })
		);
		for (const id of ["RemoteControl", "TransportDependency"]) {
			const plugin = join(root, "Engine", "Plugins", "Category", id);
			const bin = join(plugin, "Binaries", "Win64");
			await mkdir(bin, { recursive: true });
			await writeFile(
				join(plugin, `${id}.uplugin`),
				JSON.stringify({
					Modules: [{ Name: id }],
					Plugins:
						id === "RemoteControl"
							? [
									{ Name: "TransportDependency", Enabled: true },
									{ Name: "OptionalAbsent", Enabled: true, Optional: true },
									{ Name: "DisabledAbsent", Enabled: false }
								]
							: []
				})
			);
			await writeFile(
				join(bin, "UnrealEditor.modules"),
				JSON.stringify({
					BuildId: id === "RemoteControl" ? "current" : "previous",
					Modules: { [id]: `${id}.dll` }
				})
			);
			await writeFile(join(bin, `${id}.dll`), "fixture");
		}
		const check = () =>
			Effect.runPromise(Effect.result(validateUnrealRemoteControlBuild(root, "win32")));
		expect(await check()).toMatchObject({
			_tag: "Failure",
			failure: {
				code: "plugin_unavailable",
				details: expect.stringContaining("TransportDependency: plugin build previous")
			}
		});
		const dependencyBin = join(
			root,
			"Engine",
			"Plugins",
			"Category",
			"TransportDependency",
			"Binaries",
			"Win64"
		);
		await writeFile(
			join(dependencyBin, "UnrealEditor.modules"),
			JSON.stringify({
				BuildId: "current",
				Modules: { TransportDependency: "TransportDependency.dll" }
			})
		);
		expect(await check()).toMatchObject({ _tag: "Success" });
		await rm(join(dependencyBin, "TransportDependency.dll"));
		expect(await check()).toMatchObject({
			_tag: "Failure",
			failure: { details: expect.stringContaining("missing binary") }
		});
		await rm(join(dependencyBin, "UnrealEditor.modules"));
		expect(await check()).toMatchObject({
			_tag: "Failure",
			failure: { details: expect.stringContaining("missing or invalid module manifest") }
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
