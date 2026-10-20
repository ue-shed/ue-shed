import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	writeFileSync
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GAME_TEXT_PLUGIN_IDS } from "./plugin-bundle.ts";
import { isJsonString, parseJsonObject } from "./json.ts";
import { buildInputStamp, buildUnlessUnchanged, engineBuildIdentity } from "./build-stamp.ts";
import { traceProcess } from "./process-trace.ts";

export interface UnrealEngineVersion {
	readonly major: number;
	readonly minor: number;
	readonly label: string;
}

export interface UnrealEngineTools {
	readonly build: string;
	readonly editor: string;
	readonly editorCommandlet: string;
}

interface UnrealPluginDescriptor {
	readonly Modules: ReadonlyArray<{ readonly Name: string }>;
}

interface UnrealModuleManifest {
	readonly BuildId: unknown;
	readonly Modules: Readonly<Record<string, string>>;
}

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const ueShedPluginRoot = join(repositoryRoot, "unreal", "Plugins");
export const ueShedPluginIds = Object.freeze([
	"UEShedCore",
	"UEShedWorld",
	"UEShedAuthoring",
	"UEShedAutomation",
	"UEShedCameras",
	"UEShedCameraAuthoringBridge",
	"UEShedCameraAuthoring",
	"UEShedObservatory",
	"UEShedNiagara",
	"UEShedAssetAudits",
	"UEShedScenarios",
	"UEShedGameText"
]);

export function unrealEngineVersion(engineRoot: string): UnrealEngineVersion | undefined {
	const versionPath = join(engineRoot, "Engine", "Build", "Build.version");
	if (!existsSync(versionPath)) return undefined;
	// SAFETY: Build.version is an Unreal-owned file with stable numeric version fields.
	const version = JSON.parse(readFileSync(versionPath, "utf8")) as {
		readonly MajorVersion: number;
		readonly MinorVersion: number;
	};
	return {
		major: version.MajorVersion,
		minor: version.MinorVersion,
		label: `${version.MajorVersion}.${version.MinorVersion}`
	};
}

export function unrealEngineTools(engineRoot: string): UnrealEngineTools {
	if (process.platform !== "win32") {
		throw new Error("UE Shed's local Unreal build helpers currently support Windows only.");
	}
	const editorName = unrealEngineVersion(engineRoot)?.major === 4 ? "UE4Editor" : "UnrealEditor";
	return {
		build: join(engineRoot, "Engine", "Build", "BatchFiles", "Build.bat"),
		editor: join(engineRoot, "Engine", "Binaries", "Win64", `${editorName}.exe`),
		editorCommandlet: join(engineRoot, "Engine", "Binaries", "Win64", `${editorName}-Cmd.exe`)
	};
}

/**
 * Derived-data cache arguments for the repository's `-NullRHI` Unreal processes. `-ddc=NoShared`
 * skips shared caches: tests must not depend on a studio cache, and an unreachable one (such as
 * `UE-ZenSharedDataCacheHost` while off the network) stalls every engine startup for about 10 s.
 * Unreal 4.27, 5.7 and 5.8 all define the `NoShared` graph. Never pass it to a rendering editor:
 * in 5.7 that graph drops the engine shader pak and leaves the local file cache delete-only, so the
 * editor recompiles engine shaders for minutes before Remote Control starts.
 */
export const localDerivedDataCacheArguments = ["-ddc=NoShared"] as const;

export function runProcess(command: string, args: readonly string[]) {
	const isBatchFile = command.endsWith(".bat") || command.endsWith(".cmd");
	const executable = isBatchFile
		? [command, ...args].map((arg) => `"${arg.replaceAll('"', '""')}"`).join(" ")
		: command;
	const result = traceProcess(command, args, () =>
		spawnSync(executable, isBatchFile ? [] : args, {
			cwd: repositoryRoot,
			shell: isBatchFile,
			stdio: "inherit",
			windowsHide: true
		})
	);
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(
			result.signal
				? `${basename(command)} received ${result.signal}.`
				: `${basename(command)} exited with ${result.status ?? "an unknown status"}.`
		);
	}
}

export function ueShedPluginDescriptors(ids: readonly string[] = ueShedPluginIds) {
	return ids.map((id) => {
		const descriptor = join(ueShedPluginRoot, id, `${id}.uplugin`);
		if (!existsSync(descriptor)) throw new Error(`Missing UE Shed plugin: ${descriptor}`);
		return descriptor;
	});
}

function copyFileIfChanged(source: string, destination: string) {
	if (existsSync(destination) && readFileSync(source).equals(readFileSync(destination))) return;
	copyFileSync(source, destination);
}

function writeFileIfChanged(path: string, content: string) {
	if (existsSync(path) && readFileSync(path, "utf8") === content) return;
	writeFileSync(path, content);
}

export function stagePluginRuntime(
	hostRoot: string,
	descriptors = ueShedPluginDescriptors(),
	builtModules?: UnrealModuleManifest,
	editorTarget = "UnrealEditor"
) {
	const hostBinariesRoot = join(hostRoot, "Binaries", "Win64");
	const runtimePluginRoot = join(hostRoot, "RuntimePlugins");
	return descriptors.map((descriptor) => {
		const pluginId = basename(descriptor, ".uplugin");
		// UE4 writes installed-engine plugin outputs beside each source descriptor.
		const binariesRoot =
			builtModules || existsSync(join(hostBinariesRoot, `${editorTarget}.modules`))
				? hostBinariesRoot
				: join(dirname(descriptor), "Binaries", "Win64");
		// SAFETY: UBT generated the module manifest for this selected engine and plugin.
		const moduleManifest =
			builtModules ??
			(JSON.parse(
				readFileSync(join(binariesRoot, `${editorTarget}.modules`), "utf8")
			) as UnrealModuleManifest);
		// SAFETY: descriptors are UE Shed-owned .uplugin files selected by ueShedPluginDescriptors.
		const plugin = JSON.parse(readFileSync(descriptor, "utf8")) as UnrealPluginDescriptor;
		const stagedPluginRoot = join(runtimePluginRoot, pluginId);
		const stagedBinariesRoot = join(stagedPluginRoot, "Binaries", "Win64");
		mkdirSync(stagedBinariesRoot, { recursive: true });
		copyFileIfChanged(descriptor, join(stagedPluginRoot, `${pluginId}.uplugin`));
		const configRoot = join(dirname(descriptor), "Config");
		if (existsSync(configRoot)) {
			cpSync(configRoot, join(stagedPluginRoot, "Config"), { force: true, recursive: true });
		}
		const stagedModules = Object.fromEntries(
			plugin.Modules.map(({ Name: moduleName }) => {
				const binaryName = moduleManifest.Modules[moduleName];
				if (!binaryName) {
					throw new Error(`The disposable build did not produce module ${moduleName}.`);
				}
				copyFileIfChanged(
					join(binariesRoot, binaryName),
					join(stagedBinariesRoot, binaryName)
				);
				const symbolsName = binaryName.replace(/\.dll$/i, ".pdb");
				if (existsSync(join(binariesRoot, symbolsName))) {
					copyFileIfChanged(
						join(binariesRoot, symbolsName),
						join(stagedBinariesRoot, symbolsName)
					);
				}
				return [moduleName, binaryName];
			})
		);
		writeFileIfChanged(
			join(stagedBinariesRoot, `${editorTarget}.modules`),
			`${JSON.stringify({ BuildId: moduleManifest.BuildId, Modules: stagedModules }, null, "\t")}\n`
		);
		return join(stagedPluginRoot, `${pluginId}.uplugin`);
	});
}

export function prepareUnrealPlugins({
	engineRoot,
	projectPath,
	tools,
	additionalPluginDescriptors = [],
	pluginIds = unrealEngineVersion(engineRoot)?.major === 4
		? GAME_TEXT_PLUGIN_IDS
		: ueShedPluginIds,
	coreRuntimeOnly = unrealEngineVersion(engineRoot)?.major === 4
}: {
	readonly engineRoot: string;
	readonly projectPath: string;
	readonly tools: UnrealEngineTools;
	readonly additionalPluginDescriptors?: readonly string[];
	readonly pluginIds?: readonly string[];
	readonly coreRuntimeOnly?: boolean;
}) {
	const version = unrealEngineVersion(engineRoot);
	if (!version) throw new Error(`Could not read the Unreal version under ${engineRoot}.`);
	const hostRoot = process.env.UE_SHED_PLUGIN_HOST_ROOT
		? resolve(process.env.UE_SHED_PLUGIN_HOST_ROOT)
		: join(
				repositoryRoot,
				"out",
				"workbench-plugin-host",
				version.label,
				"engine-" +
					createHash("sha256")
						.update(
							process.platform === "win32"
								? realpathSync(engineRoot).toLowerCase()
								: realpathSync(engineRoot)
						)
						.digest("hex")
						.slice(0, 16)
			);
	const editorTarget = version.major === 4 ? "UE4Editor" : "UnrealEditor";
	// Stage a bounded source graph without modifying canonical descriptors.
	const selectedRoot = join(hostRoot, coreRuntimeOnly ? "GameTextSources" : "Sources");
	mkdirSync(selectedRoot, { recursive: true });
	const descriptors = ueShedPluginDescriptors(pluginIds).map((descriptor) => {
		const id = basename(descriptor, ".uplugin");
		const destination = join(selectedRoot, id);
		cpSync(dirname(descriptor), destination, {
			recursive: true,
			force: true,
			filter: (source) => {
				const path = relative(dirname(descriptor), source).split(/[\\/]/u);
				return (
					!["Binaries", "Intermediate"].includes(path[0] ?? "") &&
					!(
						coreRuntimeOnly &&
						id === "UEShedCore" &&
						path[0] === "Source" &&
						path[1] === "UEShedCoreEditor"
					)
				);
			}
		});
		const staged = join(destination, `${id}.uplugin`);
		if (coreRuntimeOnly && id === "UEShedCore") {
			// SAFETY: this is the canonical UE Shed descriptor copied immediately above.
			const plugin = JSON.parse(readFileSync(staged, "utf8")) as UnrealPluginDescriptor;
			writeFileIfChanged(
				staged,
				`${JSON.stringify({ ...plugin, Modules: plugin.Modules.filter(({ Name }) => Name === "UEShedCore") }, null, "\t")}\n`
			);
		}
		return staged;
	});
	descriptors.push(...additionalPluginDescriptors);
	const hostProject = join(hostRoot, "UEShedPluginHost.uproject");
	mkdirSync(hostRoot, { recursive: true });
	writeFileSync(
		hostProject,
		`${JSON.stringify(
			{
				FileVersion: 3,
				EngineAssociation: version.label,
				Category: "Development",
				Description: `Disposable UE Shed plugin host for ${basename(projectPath)}.`,
				AdditionalPluginDirectories: [
					relative(hostRoot, selectedRoot),
					...additionalPluginDescriptors.map((descriptor) =>
						relative(hostRoot, dirname(dirname(descriptor)))
					)
				]
			},
			null,
			"\t"
		)}\n`
	);
	const sourceEngine = !existsSync(join(engineRoot, "Engine", "Build", "InstalledBuild.txt"));
	// Build only the requested UE5 modules, including on installed engines. Optional engine
	// plugins can otherwise enter the target-wide action graph and require engine changes.
	const moduleOnly = sourceEngine || version.major >= 5;
	const modules = descriptors.flatMap((descriptor) => {
		// SAFETY: these are the same plugin descriptors consumed by UnrealBuildTool.
		const plugin = JSON.parse(readFileSync(descriptor, "utf8")) as UnrealPluginDescriptor;
		return plugin.Modules.map(({ Name }) => Name);
	});
	const engineManifestPath = join(
		engineRoot,
		"Engine",
		"Binaries",
		"Win64",
		`${editorTarget}.modules`
	);
	const engineManifestBefore = moduleOnly ? readFileSync(engineManifestPath, "utf8") : undefined;
	const buildArgs = [
		editorTarget,
		"Win64",
		"Development",
		`-Project=${hostProject}`,
		`-AdditionalPlugins=${[...pluginIds, ...additionalPluginDescriptors.map((descriptor) => basename(descriptor, ".uplugin"))].join("+")}`,
		...(moduleOnly ? modules.map((name) => `-Module=${name}`) : []),
		"-NoUBTMakefiles",
		"-ForceHeaderGeneration",
		"-NoEngineChanges",
		"-NoHotReload",
		"-WaitMutex"
	];
	if (moduleOnly) {
		// The staged copies are rewritten every run, so fingerprint the canonical plugin sources.
		buildUnlessUnchanged({
			stampFile: join(hostRoot, "build-inputs.sha256"),
			stamp: buildInputStamp(
				[
					...ueShedPluginDescriptors(pluginIds).map((descriptor) => dirname(descriptor)),
					...additionalPluginDescriptors.map((descriptor) => dirname(descriptor))
				],
				[
					...engineBuildIdentity(engineRoot, editorTarget),
					...buildArgs,
					String(coreRuntimeOnly)
				]
			),
			outputs: modules.map((name) =>
				join(hostRoot, "Binaries", "Win64", `${editorTarget}-${name}.dll`)
			),
			build: () => runProcess(tools.build, buildArgs)
		});
	} else {
		runProcess(tools.build, buildArgs);
	}
	if (engineManifestBefore !== undefined) {
		if (readFileSync(engineManifestPath, "utf8") !== engineManifestBefore) {
			throw new Error(
				"The engine build changed during plugin compilation. Retry after the engine build finishes."
			);
		}
		// Module-only builds deliberately omit target-wide metadata generation. These newly
		// built Win64 Development DLLs link against the existing engine, protected by
		// -NoEngineChanges. Stage their manifest with that engine's identity, never a stale
		// disposable-host manifest or another installation's build ID.
		const engineManifest = parseJsonObject(engineManifestBefore);
		if (!isJsonString(engineManifest.BuildId) || !engineManifest.BuildId) {
			throw new Error(
				"The selected engine has no module build ID. Build its Editor target first."
			);
		}
		return stagePluginRuntime(
			hostRoot,
			descriptors,
			{
				BuildId: engineManifest.BuildId,
				Modules: Object.fromEntries(
					modules.map((name) => [name, `${editorTarget}-${name}.dll`])
				)
			},
			editorTarget
		);
	}
	return stagePluginRuntime(hostRoot, descriptors, undefined, editorTarget);
}
