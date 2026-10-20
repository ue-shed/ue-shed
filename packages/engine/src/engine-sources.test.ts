import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import { installedEngineRoots, registeredBuildRoot, type RegistryQuery } from "./engine-sources.js";

const machine = Effect.acquireRelease(
	Effect.promise(async () => {
		const root = await mkdtemp(join(tmpdir(), "ue-shed-engine-sources-"));
		await mkdir(join(root, "ProgramData", "Epic", "UnrealEngineLauncher"), { recursive: true });
		await mkdir(join(root, "Program Files", "Epic Games", "UE_5.6"), { recursive: true });
		await writeFile(
			join(root, "ProgramData", "Epic", "UnrealEngineLauncher", "LauncherInstalled.dat"),
			JSON.stringify({
				InstallationList: [
					{ AppName: "FabPlugin_5.7", InstallLocation: "D:\\ue5\\UE_5.7" },
					{ AppName: "UE_5.7", InstallLocation: "D:\\ue5\\UE_5.7" },
					{ AppName: "UE_5.8", InstallLocation: "D:\\ue5\\UE_5.8" }
				]
			})
		);
		return root;
	}),
	(root) => Effect.promise(() => rm(root, { recursive: true, force: true }))
);

const launcherKeys: RegistryQuery = (args) =>
	Effect.succeed(
		args.includes("HKLM\\SOFTWARE\\EpicGames\\Unreal Engine")
			? [
					"",
					"HKEY_LOCAL_MACHINE\\SOFTWARE\\EpicGames\\Unreal Engine\\4.27",
					"    InstalledDirectory    REG_SZ    E:\\Engines\\UE_4.27",
					"",
					"HKEY_LOCAL_MACHINE\\SOFTWARE\\EpicGames\\Unreal Engine\\5.7",
					"    InstalledDirectory    REG_SZ    d:\\UE5\\UE_5.7",
					"",
					"End of search: 2 match(es) found."
				].join("\r\n")
			: undefined
	);

it.effect("lists Program Files, Launcher list and Launcher registry engines once each", () =>
	Effect.gen(function* () {
		const root = yield* machine;
		const roots = yield* installedEngineRoots({
			platform: "win32",
			programData: join(root, "ProgramData"),
			programFiles: join(root, "Program Files"),
			queryRegistry: launcherKeys
		});
		expect(roots).toEqual([
			resolve(root, "Program Files", "Epic Games", "UE_5.6"),
			resolve("D:\\ue5\\UE_5.7"),
			resolve("D:\\ue5\\UE_5.8"),
			resolve("E:\\Engines\\UE_4.27")
		]);
	}).pipe(Effect.scoped)
);

it.effect("finds nothing outside Windows and tolerates a missing Launcher", () =>
	Effect.gen(function* () {
		const sources = {
			programData: join(tmpdir(), "ue-shed-no-launcher"),
			programFiles: join(tmpdir(), "ue-shed-no-program-files"),
			queryRegistry: launcherKeys
		};
		expect(yield* installedEngineRoots({ ...sources, platform: "linux" })).toEqual([]);
		expect(yield* installedEngineRoots({ ...sources, platform: "win32" })).toEqual([
			resolve("E:\\Engines\\UE_4.27"),
			resolve("d:\\UE5\\UE_5.7")
		]);
	})
);

it.effect("resolves a custom association from Unreal's registered builds", () =>
	Effect.gen(function* () {
		const queryRegistry: RegistryQuery = (args) =>
			Effect.succeed(
				args.includes("UE-Studio")
					? "\r\nHKEY_CURRENT_USER\\Software\\Epic Games\\Unreal Engine\\Builds\r\n    UE-Studio    REG_SZ    E:/Engines/UE-Studio\r\n"
					: undefined
			);
		expect(yield* registeredBuildRoot("UE-Studio", { platform: "win32", queryRegistry })).toBe(
			resolve("E:/Engines/UE-Studio")
		);
		expect(yield* registeredBuildRoot("UE-Missing", { platform: "win32", queryRegistry })).toBe(
			undefined
		);
		expect(yield* registeredBuildRoot("UE-Studio", { platform: "linux", queryRegistry })).toBe(
			undefined
		);
	})
);
