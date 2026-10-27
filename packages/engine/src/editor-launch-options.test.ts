import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { it } from "@effect/vitest";
import { Effect, Layer, Ref } from "effect";
import { expect } from "vitest";
import { pendingPackageRecovery, reservedUnrealEditorArgument } from "./editor-launch-options.js";
import { makeEngineInstallationDiscoveryTestLayer } from "./engine-installation.js";
import {
	UnrealProjectLauncher,
	UnrealProjectLauncherLive,
	makeUnrealProjectProcessTestLayer,
	unrealProjectLaunchArguments,
	type UnrealProjectLaunchRequest,
	type UnrealProjectProcessLaunchOptions
} from "./project-launcher.js";

it("puts the startup map right after the project and the run's options last", () => {
	const args = unrealProjectLaunchArguments({
		additionalArguments: ["-nosplash"],
		logPath: "D:/Logs/run.log",
		mode: {
			kind: "with_plugins",
			plugins: [{ descriptor: "C:/Plugins/UEShedCore.uplugin", id: "UEShedCore" }],
			remoteControlAllowedFunctions: [
				{ classPath: "UnrealEd.EditorActorSubsystem", functionName: "GetAllLevelActors" }
			],
			remoteControlHttpPort: 30_001,
			remoteControlWebSocketPort: 31_000
		},
		projectDescriptor: "D:/Projects/Hex/Hex.uproject",
		sourceControl: "disabled",
		startupMap: "/Game/Maps/Arena"
	});
	expect(args.slice(0, 3)).toEqual([
		resolve("D:/Projects/Hex/Hex.uproject"),
		"/Game/Maps/Arena",
		`-PLUGIN=${resolve("C:/Plugins/UEShedCore.uplugin")}`
	]);
	expect(args.slice(-3)).toEqual([
		`-abslog=${resolve("D:/Logs/run.log")}`,
		"-SCCProvider=None",
		"-nosplash"
	]);
	expect(args).toContain(
		"-ini:RemoteControl:[/Script/RemoteControlCommon.RemoteControlSettings]:RemoteControlWebSocketServerPort=31000"
	);
	expect(args).toContain(
		'-ini:RemoteControl:[/Script/RemoteControlCommon.RemoteControlSettings]:+CustomAllowedRemoteFunctionCalls=(ClassPath="/Script/UnrealEd.EditorActorSubsystem",FunctionName=("GetAllLevelActors"),bAllowChildClasses=False)'
	);
	expect(args).toContain(
		"-ini:EditorPerProjectUserSettings:[/Script/LiveCoding.LiveCodingSettings]:bEnabled=False"
	);
	expect(args).not.toContain("-NoLiveCoding");
});

it("refuses the switches the launcher owns and allows the rest", () => {
	for (const argument of [
		"/Game/Maps/Other",
		"Arena",
		"-PLUGIN=C:/Other.uplugin",
		"-enableplugins=Other",
		"-NullRHI",
		"-run=GatherText",
		"-ABSLOG=C:/x.log",
		"-log=x.log",
		"-Unattended",
		"-SCCProvider=Perforce",
		"-AutoDeclinePackageRecovery",
		"-LiveCoding=true",
		"-map=/Game/Maps/Arena",
		"-ini:RemoteControl:[/Script/RemoteControlCommon.RemoteControlSettings]:bAutoStartWebServer=False",
		"-ini:EditorPerProjectUserSettings:[/Script/LiveCoding.LiveCodingSettings]:bEnabled=True",
		"-DisablePlugins=Foo,remotecontrol",
		"-DisablePlugins=UEShedCore"
	])
		expect(reservedUnrealEditorArgument(argument, ["UEShedCore"]), argument).toBeDefined();
	for (const argument of [
		"-nosplash",
		"-nosound",
		"-log",
		"-culture=fr",
		"-ExecCmds=stat fps",
		"-DisablePlugins=PlasticSourceControl",
		"-ini:EditorPerProjectUserSettings:[/Script/UnrealEd.EditorPerformanceSettings]:bThrottleCPUWhenNotForeground=False"
	])
		expect(reservedUnrealEditorArgument(argument, ["UEShedCore"]), argument).toBeUndefined();
});

function launcherFixture() {
	return Effect.gen(function* () {
		const root = yield* Effect.promise(() =>
			mkdtemp(join(tmpdir(), "ue-shed-launch-options-"))
		);
		const binaries = join(root, "Engine", "Binaries");
		const executable =
			process.platform === "win32"
				? join(binaries, "Win64", "UnrealEditor.exe")
				: process.platform === "darwin"
					? join(binaries, "Mac", "UnrealEditor.app", "Contents", "MacOS", "UnrealEditor")
					: join(binaries, "Linux", "UnrealEditor");
		const projectDescriptor = join(root, "Project", "Fixture.uproject");
		yield* Effect.promise(async () => {
			await mkdir(dirname(executable), { recursive: true });
			await mkdir(join(root, "Project", "Content", "Maps"), { recursive: true });
			await writeFile(executable, "");
			await writeFile(projectDescriptor, "{}");
			await writeFile(join(root, "Project", "Content", "Maps", "Arena.umap"), "");
		});
		const launches = yield* Ref.make<readonly UnrealProjectProcessLaunchOptions[]>([]);
		const layer = UnrealProjectLauncherLive.pipe(
			Layer.provide(
				Layer.merge(
					makeEngineInstallationDiscoveryTestLayer(() =>
						Effect.succeed({ root, version: { major: 5, minor: 8, patch: 0 } })
					),
					makeUnrealProjectProcessTestLayer((options) =>
						Ref.update(launches, (current) => [...current, options]).pipe(Effect.as(7))
					)
				)
			)
		);
		return { launches, layer, projectDescriptor, root };
	});
}

it.effect("checks the startup map, refused switches and log path before spawning", () =>
	Effect.gen(function* () {
		const fixture = yield* launcherFixture();
		const launch = (
			options: Pick<
				UnrealProjectLaunchRequest,
				"additionalArguments" | "logPath" | "startupMap"
			>
		) =>
			Effect.flatMap(UnrealProjectLauncher, (launcher) =>
				launcher.launch({
					mode: { kind: "normal" },
					projectDescriptor: fixture.projectDescriptor,
					...options
				})
			).pipe(Effect.provide(fixture.layer));
		expect(yield* Effect.flip(launch({ startupMap: "/Game/Maps/Missing" }))).toMatchObject({
			code: "startup_map_missing",
			nextStep: "fix_input"
		});
		expect(yield* Effect.flip(launch({ additionalArguments: ["-NullRHI"] }))).toMatchObject({
			code: "invalid_request",
			message: expect.stringContaining("-NullRHI")
		});
		expect(yield* Effect.flip(launch({ logPath: "relative.log" }))).toMatchObject({
			code: "invalid_request"
		});
		expect(yield* Ref.get(fixture.launches)).toEqual([]);
		const logPath = join(fixture.root, "Logs", "Run", "editor.log");
		expect(yield* launch({ logPath, startupMap: "/Game/Maps/Arena" })).toMatchObject({
			logPath,
			pid: 7
		});
		expect((yield* Ref.get(fixture.launches))[0]?.args.slice(1, 2)).toEqual([
			"/Game/Maps/Arena"
		]);
		yield* Effect.promise(() => rm(fixture.root, { force: true, recursive: true }));
	})
);

it.effect("finds unsaved work the editor would offer to restore", () =>
	Effect.gen(function* () {
		const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "ue-shed-restore-")));
		const projectDescriptor = join(root, "Fixture.uproject");
		const autosaves = join(root, "Saved", "Autosaves");
		const restore = join(autosaves, "PackageRestoreData.json");
		yield* Effect.promise(() => mkdir(autosaves, { recursive: true }));
		expect(yield* pendingPackageRecovery(projectDescriptor)).toBe(false);
		yield* Effect.promise(() =>
			writeFile(restore, JSON.stringify({ RestoreEnabled: false, Packages: [] }))
		);
		expect(yield* pendingPackageRecovery(projectDescriptor)).toBe(false);
		yield* Effect.promise(() =>
			writeFile(
				restore,
				JSON.stringify({
					RestoreEnabled: true,
					Packages: [{ PackagePathName: "/Game/Maps/Arena", AutoSavePath: "x" }]
				})
			)
		);
		expect(yield* pendingPackageRecovery(projectDescriptor)).toBe(true);
		yield* Effect.promise(() => writeFile(restore, "{"));
		expect(yield* pendingPackageRecovery(projectDescriptor)).toBe(true);
		yield* Effect.promise(() => rm(root, { force: true, recursive: true }));
	})
);
