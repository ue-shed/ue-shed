import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { it } from "@effect/vitest";
import { Effect, Layer, Ref } from "effect";
import { expect } from "vitest";
import { unrealRemoteControlPermissions } from "./remote-control-permissions.js";
import {
	EngineInstallationError,
	makeEngineInstallationDiscoveryTestLayer
} from "./engine-installation.js";
import {
	UnrealProjectLauncher,
	UnrealProjectLauncherLive,
	makeUnrealProjectProcessTestLayer,
	unrealEditorCommandletExecutable,
	unrealEditorExecutable,
	unrealProjectLaunchArguments,
	validateUnrealProjectBuildId,
	validateUnrealRemoteControlBuild,
	type UnrealProjectProcessLaunchOptions
} from "./project-launcher.js";

it.effect("keeps discovery identity and its nested IO cause through launch translation", () => {
	const original = new Error("fixture IO failure");
	const discovery = new EngineInstallationError({
		code: "engine_not_found",
		message: "The configured engine is unavailable.",
		recovery: "Choose an installed engine.",
		retrySafe: false,
		nextStep: "fix_input",
		cause: original
	});
	const layer = UnrealProjectLauncherLive.pipe(
		Layer.provide(
			Layer.merge(
				makeEngineInstallationDiscoveryTestLayer(() => Effect.fail(discovery)),
				makeUnrealProjectProcessTestLayer(() => Effect.die("must not spawn"))
			)
		)
	);
	return Effect.gen(function* () {
		const launcher = yield* UnrealProjectLauncher;
		const failure = yield* Effect.flip(
			launcher.launch({ mode: { kind: "normal" }, projectDescriptor: "Game.uproject" })
		);
		expect(failure.code).toBe("engine_discovery_failed");
		expect(failure.cause).toBe(discovery);
		expect(discovery.cause).toBe(original);
	}).pipe(Effect.provide(layer));
});

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
			failure: { code: "invalid_module_manifest", cause: expect.any(SyntaxError) }
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

/** Unreal's on-disk editor layout for the host, spelled out independently of the helper. */
function editorExecutableFixture(root: string, name: "UE4Editor" | "UnrealEditor"): string {
	const binaries = join(root, "Engine", "Binaries");
	if (process.platform === "win32") return join(binaries, "Win64", `${name}.exe`);
	if (process.platform === "darwin")
		return join(binaries, "Mac", `${name}.app`, "Contents", "MacOS", name);
	return join(binaries, "Linux", name);
}

it("resolves UE4 and UE5 editor executable paths", () => {
	const ue4 = { major: 4, minor: 27, patch: 2 };
	const ue5 = { major: 5, minor: 7, patch: 0 };
	expect(unrealEditorExecutable("/UE", "win32", ue4)).toBe(
		join("/UE/Engine/Binaries/Win64/UE4Editor.exe")
	);
	expect(unrealEditorExecutable("/UE", "win32", ue5)).toBe(
		join("/UE/Engine/Binaries/Win64/UnrealEditor.exe")
	);
	expect(unrealEditorExecutable("/UE", "linux", ue4)).toBe(
		join("/UE/Engine/Binaries/Linux/UE4Editor")
	);
	expect(unrealEditorExecutable("/UE", "linux", ue5)).toBe(
		join("/UE/Engine/Binaries/Linux/UnrealEditor")
	);
	expect(unrealEditorExecutable("/UE", "darwin", ue4)).toBe(
		join("/UE/Engine/Binaries/Mac/UE4Editor.app/Contents/MacOS/UE4Editor")
	);
	expect(unrealEditorExecutable("/UE", "darwin", ue5)).toBe(
		join("/UE/Engine/Binaries/Mac/UnrealEditor.app/Contents/MacOS/UnrealEditor")
	);
	expect(unrealEditorExecutable("C:/UE", "win32")).toBe(
		join("C:/UE", "Engine", "Binaries", "Win64", "UnrealEditor.exe")
	);
});

it.effect("launches a UE4 project with Remote Control using UE4Editor binaries", () =>
	Effect.gen(function* () {
		const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "ue-shed-ue4-launch-")));
		const folder =
			process.platform === "win32"
				? "Win64"
				: process.platform === "darwin"
					? "Mac"
					: "Linux";
		const engineBin = join(root, "Engine", "Binaries", folder);
		const executable = editorExecutableFixture(root, "UE4Editor");
		const projectDescriptor = join(root, "Project", "Fixture.uproject");
		const projectBin = join(root, "Project", "Binaries", folder);
		const plugin = join(root, "Engine", "Plugins", "VirtualProduction", "RemoteControl");
		const pluginBin = join(plugin, "Binaries", folder);
		yield* Effect.promise(async () => {
			for (const directory of [dirname(executable), engineBin, projectBin, pluginBin])
				await mkdir(directory, { recursive: true });
			await writeFile(executable, "");
			await writeFile(projectDescriptor, "{}");
			await writeFile(
				join(engineBin, "UE4Editor.modules"),
				JSON.stringify({ BuildId: "427" })
			);
			await writeFile(
				join(projectBin, "UE4Editor.modules"),
				JSON.stringify({ BuildId: "427" })
			);
			await writeFile(
				join(plugin, "RemoteControl.uplugin"),
				JSON.stringify({ Modules: [{ Name: "RemoteControl" }] })
			);
			await writeFile(
				join(pluginBin, "UE4Editor.modules"),
				JSON.stringify({
					BuildId: "427",
					Modules: { RemoteControl: "UE4Editor-RemoteControl.dll" }
				})
			);
			await writeFile(join(pluginBin, "UE4Editor-RemoteControl.dll"), "fixture");
		});
		const launches = yield* Ref.make<readonly UnrealProjectProcessLaunchOptions[]>([]);
		const layer = UnrealProjectLauncherLive.pipe(
			Layer.provide(
				Layer.merge(
					makeEngineInstallationDiscoveryTestLayer(() =>
						Effect.succeed({ root, version: { major: 4, minor: 27, patch: 2 } })
					),
					makeUnrealProjectProcessTestLayer((options) =>
						Ref.update(launches, (current) => [...current, options]).pipe(Effect.as(42))
					)
				)
			)
		);
		const launch = Effect.flatMap(UnrealProjectLauncher, (launcher) =>
			launcher.launch({
				mode: { kind: "with_plugins", plugins: [], remoteControlHttpPort: 30_001 },
				projectDescriptor
			})
		).pipe(Effect.provide(layer));
		expect(yield* launch).toMatchObject({ executable, pid: 42 });
		yield* Effect.promise(() =>
			writeFile(join(projectBin, "UE4Editor.modules"), JSON.stringify({ BuildId: "other" }))
		);
		expect(yield* Effect.result(launch)).toMatchObject({
			_tag: "Failure",
			failure: { code: "build_mismatch" }
		});
		expect(yield* Ref.get(launches)).toHaveLength(1);
		yield* Effect.promise(() => rm(root, { force: true, recursive: true }));
	})
);

it("resolves platform commandlet executable paths", () => {
	const platforms = ["win32", "darwin", "linux"] satisfies readonly NodeJS.Platform[];
	for (const platform of platforms) {
		const folder = platform === "win32" ? "Win64" : platform === "darwin" ? "Mac" : "Linux";
		const extension = platform === "win32" ? ".exe" : "";
		expect(
			unrealEditorCommandletExecutable("/UE", platform, { major: 4, minor: 27, patch: 2 })
		).toBe(join("/UE", "Engine", "Binaries", folder, `UE4Editor-Cmd${extension}`));
		expect(
			unrealEditorCommandletExecutable("/UE", platform, { major: 5, minor: 8, patch: 2 })
		).toBe(join("/UE", "Engine", "Binaries", folder, `UnrealEditor-Cmd${extension}`));
	}
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
		const folder =
			process.platform === "win32"
				? "Win64"
				: process.platform === "darwin"
					? "Mac"
					: "Linux";
		const executable = editorExecutableFixture(root, "UnrealEditor");
		const projectDescriptor = join(root, "Fixture.uproject");
		yield* Effect.promise(() => mkdir(dirname(executable), { recursive: true }));
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
		const projectBinaries = join(root, "Binaries", folder);
		yield* Effect.promise(async () => {
			await mkdir(projectBinaries, { recursive: true });
			await writeFile(
				join(root, "Engine", "Binaries", folder, "UnrealEditor.modules"),
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
		const buildFiles = join(root, "Engine", "Build", "BatchFiles");
		const ubtSource = join(root, "Engine", "Source", "Programs", "UnrealBuildTool");
		await mkdir(buildFiles, { recursive: true });
		await mkdir(ubtSource, { recursive: true });
		await writeFile(join(buildFiles, "Build.bat"), "fixture");
		await writeFile(join(ubtSource, "UnrealBuildTool.csproj"), "fixture");
		expect(await check()).toMatchObject({
			_tag: "Failure",
			failure: {
				code: "engine_plugins_stale",
				enginePlugins: {
					engineRoot: root,
					stalePlugins: ["TransportDependency"],
					buildable: true
				}
			}
		});
		const installed = join(root, "Engine", "Build", "InstalledBuild.txt");
		await writeFile(installed, "fixture");
		expect(await check()).toMatchObject({ failure: { code: "plugin_unavailable" } });
		await rm(installed);
		await rm(join(dependencyBin, "TransportDependency.dll"));
		expect(await check()).toMatchObject({ failure: { code: "plugin_unavailable" } });
		await writeFile(join(dependencyBin, "TransportDependency.dll"), "fixture");
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

it("allows the public World API only when World is enabled", () => {
	const enabled = unrealRemoteControlPermissions(["UEShedWorld"]);
	expect(enabled).toEqual([
		"-ini:RemoteControl:[/Script/RemoteControlCommon.RemoteControlSettings]:+CustomAllowedRemoteFunctionCalls=(ClassPath=/Script/UEShedWorldEditor.UEShedWorldLibrary,bAllowChildClasses=False)"
	]);
	expect(unrealRemoteControlPermissions(["UEShedCore"])).not.toContain(enabled[0]);
});
