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
import { isJsonString, parseJsonObject } from "./json.ts";

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
	"UEShedAuthoring",
	"UEShedCameras",
	"UEShedCameraAuthoringBridge",
	"UEShedCameraAuthoring",
	"UEShedObservatory",
	"UEShedNiagara",
	"UEShedAssetAudits",
	"UEShedScenarios"
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
	return {
		build: join(engineRoot, "Engine", "Build", "BatchFiles", "Build.bat"),
		editor: join(engineRoot, "Engine", "Binaries", "Win64", "UnrealEditor.exe"),
		editorCommandlet: join(engineRoot, "Engine", "Binaries", "Win64", "UnrealEditor-Cmd.exe")
	};
}

export function runProcess(command: string, args: readonly string[]) {
	const isBatchFile = command.endsWith(".bat") || command.endsWith(".cmd");
	const executable = isBatchFile
		? [command, ...args].map((arg) => `"${arg.replaceAll('"', '""')}"`).join(" ")
		: command;
	const result = spawnSync(executable, isBatchFile ? [] : args, {
		cwd: repositoryRoot,
		shell: isBatchFile,
		stdio: "inherit",
		windowsHide: true
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(
			result.signal
				? `${basename(command)} received ${result.signal}.`
				: `${basename(command)} exited with ${result.status ?? "an unknown status"}.`
		);
	}
}

export function ueShedPluginDescriptors() {
	return ueShedPluginIds.map((id) => {
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
	builtModules?: UnrealModuleManifest
) {
	const binariesRoot = join(hostRoot, "Binaries", "Win64");
	// SAFETY: UnrealBuildTool generated this module manifest for the staged engine build.
	const moduleManifest =
		builtModules ??
		(JSON.parse(
			readFileSync(join(binariesRoot, "UnrealEditor.modules"), "utf8")
		) as UnrealModuleManifest);
	const runtimePluginRoot = join(hostRoot, "RuntimePlugins");
	return descriptors.map((descriptor) => {
		const pluginId = basename(descriptor, ".uplugin");
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
			join(stagedBinariesRoot, "UnrealEditor.modules"),
			`${JSON.stringify({ BuildId: moduleManifest.BuildId, Modules: stagedModules }, null, "\t")}\n`
		);
		return join(stagedPluginRoot, `${pluginId}.uplugin`);
	});
}

export function prepareUnrealPlugins({
	engineRoot,
	projectPath,
	tools,
	additionalPluginDescriptors = []
}: {
	readonly engineRoot: string;
	readonly projectPath: string;
	readonly tools: UnrealEngineTools;
	readonly additionalPluginDescriptors?: readonly string[];
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
				createHash("sha256")
					.update(
						process.platform === "win32"
							? realpathSync(engineRoot).toLowerCase()
							: realpathSync(engineRoot)
					)
					.digest("hex")
					.slice(0, 16)
			);
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
					relative(hostRoot, ueShedPluginRoot),
					...additionalPluginDescriptors.map((descriptor) =>
						relative(hostRoot, dirname(dirname(descriptor)))
					)
				]
			},
			null,
			"\t"
		)}\n`
	);
	const descriptors = [...ueShedPluginDescriptors(), ...additionalPluginDescriptors];
	const sourceEngine = !existsSync(join(engineRoot, "Engine", "Build", "InstalledBuild.txt"));
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
		"UnrealEditor.modules"
	);
	const engineManifestBefore = sourceEngine
		? readFileSync(engineManifestPath, "utf8")
		: undefined;
	runProcess(tools.build, [
		"UnrealEditor",
		"Win64",
		"Development",
		`-Project=${hostProject}`,
		`-AdditionalPlugins=${[...ueShedPluginIds, ...additionalPluginDescriptors.map((descriptor) => basename(descriptor, ".uplugin"))].join("+")}`,
		...(sourceEngine ? [`-Module=${modules.join("+")}`] : []),
		"-NoUBTMakefiles",
		"-ForceHeaderGeneration",
		"-NoEngineChanges",
		"-NoHotReload",
		"-WaitMutex"
	]);
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
		return stagePluginRuntime(hostRoot, descriptors, {
			BuildId: engineManifest.BuildId,
			Modules: Object.fromEntries(modules.map((name) => [name, `UnrealEditor-${name}.dll`]))
		});
	}
	return stagePluginRuntime(hostRoot, descriptors);
}
