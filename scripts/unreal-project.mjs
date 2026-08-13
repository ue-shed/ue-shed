import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	prepareUnrealPlugins,
	ueShedPluginIds,
	unrealEngineTools,
	unrealEngineVersion
} from "./unreal-plugin-host.mjs";
import { parseUnrealDescriptor, registeredEngineRoot } from "./unreal-project-support.mjs";
import { unrealRemoteControlLaunchArguments } from "./workbench-tools.mjs";

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
	return unrealEngineVersion(engineRoot);
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

	const descriptor = parseUnrealDescriptor(readFileSync(projectPath, "utf8"));
	const association =
		typeof descriptor.EngineAssociation === "string" ? descriptor.EngineAssociation : undefined;
	if (process.platform === "win32") {
		const registeredRoot = registeredEngineRoot(association);
		if (registeredRoot && engineVersion(registeredRoot)) return resolve(registeredRoot);
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
	return unrealEngineTools(engineRoot);
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
			...unrealRemoteControlLaunchArguments(ueShedPluginIds, Number(port))
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
	preparedPluginDescriptors = prepareUnrealPlugins({
		engineRoot,
		projectPath: selectedProject,
		tools: engineTools
	});
}
if (action === "launch") {
	launch(root, selectedProject, engineTools, mode, preparedPluginDescriptors);
}
