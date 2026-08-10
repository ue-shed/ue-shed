import { spawn, spawnSync } from "node:child_process";
import {
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { unrealRemoteControlLaunchArguments } from "./workbench-tools.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = join(repositoryRoot, "unreal", "Plugins");
const pluginIds = Object.freeze([
	"UEShedCore",
	"UEShedAuthoring",
	"UEShedCameras",
	"UEShedObservatory",
	"UEShedAssetAudits"
]);

function option(name) {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

function projectFile(projectRoot) {
	const projects = readdirSync(projectRoot, { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".uproject"))
		.map((entry) => join(projectRoot, entry.name));
	if (projects.length !== 1) {
		throw new Error(
			projects.length === 0
				? `No .uproject file exists in ${projectRoot}.`
				: `More than one .uproject file exists in ${projectRoot}.`
		);
	}
	return projects[0];
}

function engineVersion(engineRoot) {
	const versionPath = join(engineRoot, "Engine", "Build", "Build.version");
	if (!existsSync(versionPath)) return undefined;
	const version = JSON.parse(readFileSync(versionPath, "utf8"));
	return {
		major: version.MajorVersion,
		minor: version.MinorVersion,
		label: `${version.MajorVersion}.${version.MinorVersion}`
	};
}

function discoverEngineRoot(projectPath) {
	const configured = process.env.UE_SHED_UNREAL_ENGINE_ROOT;
	if (configured) {
		const root = resolve(configured);
		if (!engineVersion(root)) {
			throw new Error(`UE_SHED_UNREAL_ENGINE_ROOT is not an Unreal installation: ${root}`);
		}
		return root;
	}

	const descriptor = JSON.parse(readFileSync(projectPath, "utf8"));
	const association =
		typeof descriptor.EngineAssociation === "string" ? descriptor.EngineAssociation : undefined;
	if (process.platform === "win32") {
		const epicRoot = join(process.env.ProgramFiles ?? "C:\\Program Files", "Epic Games");
		if (existsSync(epicRoot)) {
			const candidates = readdirSync(epicRoot, { withFileTypes: true })
				.filter((entry) => entry.isDirectory() && entry.name.startsWith("UE_"))
				.map((entry) => join(epicRoot, entry.name))
				.map((root) => ({ root, version: engineVersion(root) }))
				.filter((candidate) => candidate.version !== undefined)
				.filter(
					(candidate) =>
						association === undefined || candidate.version.label === association
				)
				.sort((left, right) =>
					left.version.label.localeCompare(right.version.label, undefined, {
						numeric: true
					})
				);
			if (candidates.length > 0) return candidates.at(-1).root;
		}
	}

	throw new Error(
		association
			? `Could not discover Unreal ${association}. Set UE_SHED_UNREAL_ENGINE_ROOT for a custom engine.`
			: "Could not discover the project's Unreal installation. Set UE_SHED_UNREAL_ENGINE_ROOT."
	);
}

function tools(engineRoot) {
	if (process.platform !== "win32") {
		throw new Error("Selected-project launch currently supports Windows builds only.");
	}
	return {
		build: join(engineRoot, "Engine", "Build", "BatchFiles", "Build.bat"),
		editor: join(engineRoot, "Engine", "Binaries", "Win64", "UnrealEditor.exe")
	};
}

function run(command, args) {
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
	if (result.status !== 0) process.exit(result.status ?? 1);
}

function pluginDescriptors() {
	return pluginIds.map((id) => {
		const descriptor = join(pluginRoot, id, `${id}.uplugin`);
		if (!existsSync(descriptor)) throw new Error(`Missing UE Shed plugin: ${descriptor}`);
		return descriptor;
	});
}

function stagePluginRuntime(hostRoot) {
	const binariesRoot = join(hostRoot, "Binaries", "Win64");
	const moduleManifest = JSON.parse(
		readFileSync(join(binariesRoot, "UnrealEditor.modules"), "utf8")
	);
	const runtimePluginRoot = join(hostRoot, "RuntimePlugins");
	return pluginDescriptors().map((descriptor) => {
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

function preparePlugins(engineRoot, projectPath, engineTools) {
	const version = engineVersion(engineRoot);
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
				AdditionalPluginDirectories: [relative(hostRoot, pluginRoot)]
			},
			null,
			"\t"
		)}\n`
	);
	run(engineTools.build, [
		"UnrealEditor",
		"Win64",
		"Development",
		`-Project=${hostProject}`,
		`-AdditionalPlugins=${pluginIds.join("+")}`,
		"-NoUBTMakefiles",
		"-NoHotReload",
		"-WaitMutex"
	]);
	return stagePluginRuntime(hostRoot);
}

function launch(projectRoot, projectPath, engineTools, mode, preparedPluginDescriptors) {
	const args = [projectPath];
	if (mode === "ue_shed") {
		const endpoint = new URL(
			process.env.UE_SHED_REMOTE_CONTROL_ENDPOINT ?? "http://127.0.0.1:30001"
		);
		const port = endpoint.port || (endpoint.protocol === "https:" ? "443" : "80");
		args.push(
			...preparedPluginDescriptors.map((descriptor) => `-PLUGIN=${descriptor}`),
			...unrealRemoteControlLaunchArguments(pluginIds, Number(port))
		);
	}
	const child = spawn(engineTools.editor, args, {
		cwd: projectRoot,
		detached: true,
		stdio: "ignore",
		windowsHide: false
	});
	child.unref();
}

const action = process.argv[2];
const mode = option("--mode");
const selectedRoot = option("--project");
if (
	!new Set(["launch", "prepare"]).has(action) ||
	!selectedRoot ||
	(action === "launch" && !new Set(["normal", "ue_shed"]).has(mode))
) {
	throw new Error(
		"Usage: node scripts/unreal-project.mjs <launch|prepare> --project <directory> [--mode <normal|ue_shed>]"
	);
}

const root = resolve(selectedRoot);
const selectedProject = projectFile(root);
const engineRoot = discoverEngineRoot(selectedProject);
const engineTools = tools(engineRoot);
let preparedPluginDescriptors;
if (action === "prepare" || mode === "ue_shed") {
	preparedPluginDescriptors = preparePlugins(engineRoot, selectedProject, engineTools);
}
if (action === "launch") {
	launch(root, selectedProject, engineTools, mode, preparedPluginDescriptors);
}
