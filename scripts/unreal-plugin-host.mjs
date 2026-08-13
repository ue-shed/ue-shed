import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const ueShedPluginRoot = join(repositoryRoot, "unreal", "Plugins");
export const ueShedPluginIds = Object.freeze([
	"UEShedCore",
	"UEShedAuthoring",
	"UEShedCameras",
	"UEShedObservatory",
	"UEShedAssetAudits",
	"UEShedScenarios"
]);

export function unrealEngineVersion(engineRoot) {
	const versionPath = join(engineRoot, "Engine", "Build", "Build.version");
	if (!existsSync(versionPath)) return undefined;
	const version = JSON.parse(readFileSync(versionPath, "utf8"));
	return {
		major: version.MajorVersion,
		minor: version.MinorVersion,
		label: `${version.MajorVersion}.${version.MinorVersion}`
	};
}

export function unrealEngineTools(engineRoot) {
	if (process.platform !== "win32") {
		throw new Error("UE Shed's local Unreal build helpers currently support Windows only.");
	}
	return {
		build: join(engineRoot, "Engine", "Build", "BatchFiles", "Build.bat"),
		editor: join(engineRoot, "Engine", "Binaries", "Win64", "UnrealEditor.exe"),
		editorCommandlet: join(engineRoot, "Engine", "Binaries", "Win64", "UnrealEditor-Cmd.exe")
	};
}

export function runProcess(command, args) {
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

export function stagePluginRuntime(hostRoot) {
	const binariesRoot = join(hostRoot, "Binaries", "Win64");
	const moduleManifest = JSON.parse(
		readFileSync(join(binariesRoot, "UnrealEditor.modules"), "utf8")
	);
	const runtimePluginRoot = join(hostRoot, "RuntimePlugins");
	return ueShedPluginDescriptors().map((descriptor) => {
		const pluginId = basename(descriptor, ".uplugin");
		const plugin = JSON.parse(readFileSync(descriptor, "utf8"));
		const stagedPluginRoot = join(runtimePluginRoot, pluginId);
		const stagedBinariesRoot = join(stagedPluginRoot, "Binaries", "Win64");
		mkdirSync(stagedBinariesRoot, { recursive: true });
		copyFileSync(descriptor, join(stagedPluginRoot, `${pluginId}.uplugin`));
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
				copyFileSync(join(binariesRoot, binaryName), join(stagedBinariesRoot, binaryName));
				const symbolsName = binaryName.replace(/\.dll$/i, ".pdb");
				if (existsSync(join(binariesRoot, symbolsName))) {
					copyFileSync(
						join(binariesRoot, symbolsName),
						join(stagedBinariesRoot, symbolsName)
					);
				}
				return [moduleName, binaryName];
			})
		);
		writeFileSync(
			join(stagedBinariesRoot, "UnrealEditor.modules"),
			`${JSON.stringify({ BuildId: moduleManifest.BuildId, Modules: stagedModules }, null, "\t")}\n`
		);
		return join(stagedPluginRoot, `${pluginId}.uplugin`);
	});
}

export function prepareUnrealPlugins({ engineRoot, projectPath, tools }) {
	const version = unrealEngineVersion(engineRoot);
	if (!version) throw new Error(`Could not read the Unreal version under ${engineRoot}.`);
	const hostRoot = process.env.UE_SHED_PLUGIN_HOST_ROOT
		? resolve(process.env.UE_SHED_PLUGIN_HOST_ROOT)
		: join(repositoryRoot, "out", "workbench-plugin-host", version.label);
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
				AdditionalPluginDirectories: [relative(hostRoot, ueShedPluginRoot)]
			},
			null,
			"\t"
		)}\n`
	);
	runProcess(tools.build, [
		"UnrealEditor",
		"Win64",
		"Development",
		`-Project=${hostProject}`,
		`-AdditionalPlugins=${ueShedPluginIds.join("+")}`,
		"-NoUBTMakefiles",
		"-NoHotReload",
		"-WaitMutex"
	]);
	return stagePluginRuntime(hostRoot);
}
