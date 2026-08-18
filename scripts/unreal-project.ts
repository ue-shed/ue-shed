import { readdirSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { Effect, Layer } from "effect";
import {
	EngineInstallationDiscovery,
	EngineInstallationDiscoveryLive,
	UnrealProjectLauncher,
	UnrealProjectLauncherLive,
	UnrealProjectProcessLive
} from "../packages/engine/src/index.ts";
import { prepareUnrealPlugins, unrealEngineTools } from "./unreal-plugin-host.ts";

type LaunchMode = "normal" | "ue_shed";

function option(name: string) {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

function projectFile(projectRoot: string) {
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

const action = process.argv[2];
const modeInput = option("--mode");
const mode: LaunchMode | undefined =
	modeInput === "normal" || modeInput === "ue_shed" ? modeInput : undefined;
const selectedRoot = option("--project");
if (
	(action !== "launch" && action !== "prepare") ||
	!selectedRoot ||
	(action === "launch" && mode === undefined)
) {
	throw new Error(
		"Usage: node scripts/unreal-project.ts <launch|prepare> --project <directory> [--mode <normal|ue_shed>]"
	);
}

const root = resolve(selectedRoot);
const selectedProject = projectFile(root);
const explicitEngineRoot = process.env.UE_SHED_UNREAL_ENGINE_ROOT;
const engineRoot = await Effect.runPromise(
	Effect.flatMap(EngineInstallationDiscovery, (engines) =>
		engines.resolve({
			projectDescriptor: selectedProject,
			...(explicitEngineRoot === undefined ? undefined : { explicitRoot: explicitEngineRoot })
		})
	).pipe(
		Effect.provide(EngineInstallationDiscoveryLive),
		Effect.map(({ root }) => root)
	)
);
const engineTools = unrealEngineTools(engineRoot);
let preparedPluginDescriptors: readonly string[] = [];
if (action === "prepare" || mode === "ue_shed") {
	preparedPluginDescriptors = prepareUnrealPlugins({
		engineRoot,
		projectPath: selectedProject,
		tools: engineTools
	});
}
if (action === "launch") {
	const endpoint = new URL(
		process.env.UE_SHED_REMOTE_CONTROL_ENDPOINT ?? "http://127.0.0.1:30001"
	);
	const port = Number(endpoint.port || (endpoint.protocol === "https:" ? "443" : "80"));
	const launchMode =
		mode === "ue_shed"
			? {
					kind: "with_plugins" as const,
					plugins: preparedPluginDescriptors.map((descriptor) => ({
						descriptor,
						id: basename(descriptor, extname(descriptor))
					})),
					remoteControlHttpPort: port
				}
			: { kind: "normal" as const };
	const launcherDependencies = Layer.merge(
		EngineInstallationDiscoveryLive,
		UnrealProjectProcessLive
	);
	await Effect.runPromise(
		Effect.flatMap(UnrealProjectLauncher, (launcher) =>
			launcher.launch({
				explicitEngineRoot: engineRoot,
				mode: launchMode,
				projectDescriptor: selectedProject
			})
		).pipe(Effect.provide(UnrealProjectLauncherLive.pipe(Layer.provide(launcherDependencies))))
	);
}
