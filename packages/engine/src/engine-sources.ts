import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Effect, Schema } from "effect";

// This module imports only Node and Effect so repository scripts can load it from source.

/**
 * Runs `reg.exe` with `args` and returns its output, or `undefined` when the key or value is
 * absent. Replace it to keep discovery away from the machine registry.
 */
export type RegistryQuery = (args: ReadonlyArray<string>) => Effect.Effect<string | undefined>;

/** Queries the Windows registry through `reg.exe`, discarding its error output. */
export const queryWindowsRegistry: RegistryQuery = (args) =>
	Effect.callback<string | undefined>((resume) => {
		const child = execFile(
			"reg.exe",
			[...args],
			{ encoding: "utf8", windowsHide: true },
			(error, stdout) => resume(Effect.succeed(error ? undefined : stdout))
		);
		return Effect.sync(() => child.kill());
	});

/**
 * Where to look for installed engines. `programData` and `programFiles` are the Windows folders of
 * the same names.
 */
export interface EngineRootSources {
	readonly platform: NodeJS.Platform;
	readonly programData: string;
	readonly programFiles: string;
	readonly queryRegistry: RegistryQuery;
}

/** The Epic Games Launcher's record of what it installed, wherever the user put it. */
const LauncherInstalled = Schema.Struct({
	InstallationList: Schema.Array(
		Schema.Struct({ AppName: Schema.String, InstallLocation: Schema.String })
	)
});

const launcherEnginesKey = "HKLM\\SOFTWARE\\EpicGames\\Unreal Engine";
const registeredBuildsKey = "HKCU\\Software\\Epic Games\\Unreal Engine\\Builds";
const registryValue = /^\s*(.*?)\s{2,}REG_(?:EXPAND_)?SZ\s{2,}(.+?)\s*$/u;

function programFilesEngineRoots(programFiles: string): Effect.Effect<ReadonlyArray<string>> {
	const epicRoot = join(programFiles, "Epic Games");
	return Effect.tryPromise(() => readdir(epicRoot, { withFileTypes: true })).pipe(
		Effect.map((entries) =>
			entries
				.filter((entry) => entry.isDirectory() && entry.name.startsWith("UE_"))
				.map((entry) => join(epicRoot, entry.name))
		),
		// oxlint-disable-next-line anti-slop/no-effect-catch-all -- Without a readable folder there are no candidates.
		Effect.orElseSucceed(() => [])
	);
}

/** Launcher engines can live on any drive; the Launcher lists them under ProgramData. */
function launcherListEngineRoots(programData: string): Effect.Effect<ReadonlyArray<string>> {
	const list = join(programData, "Epic", "UnrealEngineLauncher", "LauncherInstalled.dat");
	return Effect.gen(function* () {
		const contents = yield* Effect.tryPromise(() => readFile(list, "utf8"));
		const installed = yield* Schema.decodeUnknownEffect(LauncherInstalled)(
			yield* Effect.try(() => JSON.parse(contents))
		);
		// The list also holds Fab and Bridge plugins installed into an engine folder.
		return installed.InstallationList.filter((entry) => /^UE_\d/u.test(entry.AppName)).map(
			(entry) => entry.InstallLocation
		);
	}).pipe(
		// oxlint-disable-next-line anti-slop/no-effect-catch-all -- A missing or unreadable list has no candidates.
		Effect.orElseSucceed(() => [])
	);
}

/** The Launcher also records each engine under its own `HKLM` key, `…\Unreal Engine\5.7`. */
function launcherRegistryEngineRoots(queryRegistry: RegistryQuery) {
	return queryRegistry(["query", launcherEnginesKey, "/s", "/v", "InstalledDirectory"]).pipe(
		Effect.map((output) =>
			(output ?? "").split(/\r?\n/u).flatMap((line) => {
				const match = registryValue.exec(line);
				return match?.[1] === "InstalledDirectory" && match[2] ? [match[2]] : [];
			})
		)
	);
}

/**
 * Lists folders that may hold an installed engine, from the Launcher's install list, its `HKLM`
 * keys and `Program Files\Epic Games`, without duplicates. Entries can be stale; check each for
 * `Engine/Build/Build.version` before using it. Returns nothing outside Windows.
 */
export function installedEngineRoots(
	sources: EngineRootSources
): Effect.Effect<ReadonlyArray<string>> {
	if (sources.platform !== "win32") return Effect.succeed([]);
	return Effect.all(
		[
			programFilesEngineRoots(sources.programFiles),
			launcherListEngineRoots(sources.programData),
			launcherRegistryEngineRoots(sources.queryRegistry)
		],
		{ concurrency: "unbounded" }
	).pipe(
		Effect.map((groups) => {
			const roots = new Map<string, string>();
			for (const root of groups.flat()) {
				const key = resolve(root).toLocaleLowerCase("en-US");
				if (!roots.has(key)) roots.set(key, resolve(root));
			}
			return [...roots.values()];
		})
	);
}

/**
 * Resolves a custom engine association (such as `UE-Studio` or a GUID) from the builds Unreal
 * registers under `HKCU\Software\Epic Games\Unreal Engine\Builds`.
 */
export function registeredBuildRoot(
	association: string | undefined,
	sources: Pick<EngineRootSources, "platform" | "queryRegistry">
): Effect.Effect<string | undefined> {
	if (sources.platform !== "win32" || association === undefined) {
		return Effect.succeed(undefined);
	}
	return sources.queryRegistry(["query", registeredBuildsKey, "/v", association]).pipe(
		Effect.map((output) => {
			for (const line of (output ?? "").split(/\r?\n/u)) {
				const match = registryValue.exec(line);
				if (match?.[1] === association && match[2]) return resolve(match[2]);
			}
			return undefined;
		})
	);
}
