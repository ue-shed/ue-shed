import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureUassetExecutable } from "./native-tools.mjs";

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const workbenchRoot = join(repositoryRoot, "apps", "workbench");

const fixtureRoot = join(repositoryRoot, "fixtures", "unreal-project");
const textureRules = join(fixtureRoot, "FixtureSource", "Audits", "texture-rules.json");
const authoringAsset = join(fixtureRoot, "Content", "Fixture", "Authoring", "DT_Scalars.uasset");
const savedWorldMaps = [
	"Content/Fixture/Offline/L_OfflineWorld.umap",
	"Content/Fixture/Cameras/L_CameraLoad.umap"
].join(";");

export function unrealRemoteControlLaunchArguments(pluginIds, httpPort) {
	if (!Number.isInteger(httpPort) || httpPort < 1 || httpPort >= 65_535) {
		throw new Error("The Remote Control HTTP port must leave room for the WebSocket port.");
	}
	const enabledPlugins = [...new Set([...pluginIds, "RemoteControl"])];
	if (enabledPlugins.some((pluginId) => !/^[A-Za-z0-9_]+$/.test(pluginId))) {
		throw new Error(
			"Unreal plugin identifiers may contain only letters, numbers, and underscores."
		);
	}
	return [
		`-EnablePlugins=${enabledPlugins.join(",")}`,
		"-RCWebControlEnable",
		`-ini:RemoteControl:[/Script/RemoteControlCommon.RemoteControlSettings]:RemoteControlHttpServerPort=${httpPort}`,
		`-ini:RemoteControl:[/Script/RemoteControlCommon.RemoteControlSettings]:RemoteControlWebSocketServerPort=${httpPort + 1}`,
		"-ini:RemoteControl:[/Script/RemoteControlCommon.RemoteControlSettings]:bAutoStartWebServer=True",
		"-NoLiveCoding"
	];
}

async function portAvailable(port) {
	return new Promise((resolveAvailable) => {
		const server = createServer();
		server.unref();
		server.once("error", () => resolveAvailable(false));
		server.listen(port, "127.0.0.1", () => server.close(() => resolveAvailable(true)));
	});
}

async function remoteControlResponds(endpoint, fetchImplementation) {
	try {
		const response = await fetchImplementation(`${endpoint.replace(/\/+$/, "")}/remote/info`, {
			signal: AbortSignal.timeout(1_500)
		});
		return response.ok;
	} catch {
		return false;
	}
}

/**
 * Prefer an explicit endpoint, then a live Remote Control server already on the usual
 * ports, then the first free HTTP/WS pair for a future fixture launch.
 */
export async function resolveRemoteControlEndpoint(environment = process.env, options = {}) {
	if (environment.UE_SHED_REMOTE_CONTROL_ENDPOINT) {
		return environment.UE_SHED_REMOTE_CONTROL_ENDPOINT;
	}
	const fetchImplementation = options.fetch ?? globalThis.fetch;
	for (let port = 30_001; port <= 30_019; port += 2) {
		const endpoint = `http://127.0.0.1:${port}`;
		if (await remoteControlResponds(endpoint, fetchImplementation)) {
			return endpoint;
		}
	}
	for (let port = 30_001; port <= 30_019; port += 2) {
		if ((await portAvailable(port)) && (await portAvailable(port + 1))) {
			return `http://127.0.0.1:${port}`;
		}
	}
	throw new Error("Could not reserve a Remote Control port between 30001 and 30020.");
}

export async function createWorkbenchEnvironment(environment = process.env, options = {}) {
	const usingFixtureProject = environment.UE_SHED_PROJECT_ROOT === undefined;
	const reviewSet =
		environment.UE_SHED_REVIEW_SET ??
		(usingFixtureProject
			? join(fixtureRoot, ".ue-shed", "review", "sets", "fixture-structure.json")
			: undefined);
	return {
		...environment,
		UE_SHED_PROJECT_NAME: environment.UE_SHED_PROJECT_NAME ?? "UEShedFixture",
		UE_SHED_PROJECT_ROOT: environment.UE_SHED_PROJECT_ROOT ?? fixtureRoot,
		...(environment.UE_SHED_SAVED_WORLD_MAPS
			? { UE_SHED_SAVED_WORLD_MAPS: environment.UE_SHED_SAVED_WORLD_MAPS }
			: environment.UE_SHED_SAVED_WORLD_MAP
				? { UE_SHED_SAVED_WORLD_MAP: environment.UE_SHED_SAVED_WORLD_MAP }
				: usingFixtureProject
					? { UE_SHED_SAVED_WORLD_MAPS: savedWorldMaps }
					: {}),
		UE_SHED_AUTHORING_ASSET: environment.UE_SHED_AUTHORING_ASSET ?? authoringAsset,
		UE_SHED_REMOTE_CONTROL_ENDPOINT: await resolveRemoteControlEndpoint(environment, options),
		UE_SHED_REPOSITORY_ROOT: repositoryRoot,
		...(reviewSet ? { UE_SHED_REVIEW_SET: reviewSet } : {}),
		UE_SHED_TEXTURE_AUDIT_RULES: environment.UE_SHED_TEXTURE_AUDIT_RULES ?? textureRules,
		UE_SHED_UASSET_EXECUTABLE: ensureUassetExecutable(environment)
	};
}

async function remoteObjectCall(endpoint, objectPath, functionName, parameters = {}) {
	const response = await fetch(`${endpoint.replace(/\/+$/, "")}/remote/object/call`, {
		body: JSON.stringify({ functionName, generateTransaction: false, objectPath, parameters }),
		headers: { "content-type": "application/json" },
		method: "PUT",
		signal: AbortSignal.timeout(30_000)
	});
	if (!response.ok) throw new Error(`${functionName} failed with HTTP ${response.status}.`);
	return response.json();
}

/** Establish a clean fixture editor map before a live evidence lane. */
export async function loadFixtureEditorMap(endpoint, mapPath) {
	const loadingLibrary = "/Script/UnrealEd.Default__EditorLoadingAndSavingUtils";
	const dirty = await remoteObjectCall(endpoint, loadingLibrary, "GetDirtyMapPackages");
	if (Array.isArray(dirty.OutDirtyPackages) && dirty.OutDirtyPackages.length > 0) {
		throw new Error(
			`Refusing to switch fixture maps while dirty maps exist: ${dirty.OutDirtyPackages.join(", ")}`
		);
	}
	await remoteObjectCall(
		endpoint,
		"/Script/UEShedCoreEditor.Default__UEShedEditorPlaySessionLibrary",
		"StopPlaySession"
	).catch(() => undefined);
	const loaded = await remoteObjectCall(endpoint, loadingLibrary, "LoadMap", {
		Filename: mapPath
	});
	if (typeof loaded.ReturnValue !== "string" || !loaded.ReturnValue.startsWith(`${mapPath}.`)) {
		throw new Error(`Unreal did not confirm loading ${mapPath}.`);
	}
}

export function runPnpm(args, environment) {
	const pnpmScript = environment.npm_execpath;
	const pnpmScriptIsJavaScript = pnpmScript ? /\.(?:c|m)?js$/i.test(pnpmScript) : false;
	const command = pnpmScriptIsJavaScript
		? process.execPath
		: (pnpmScript ?? (process.platform === "win32" ? "pnpm.cmd" : "pnpm"));
	const commandPrefix = pnpmScriptIsJavaScript && pnpmScript ? [pnpmScript] : [];
	const commandNeedsShell =
		process.platform === "win32" && (!pnpmScript || /\.(?:cmd|bat)$/i.test(pnpmScript));
	const result = spawnSync(command, [...commandPrefix, ...args], {
		cwd: repositoryRoot,
		env: environment,
		shell: commandNeedsShell,
		stdio: "inherit",
		windowsHide: true
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		const resultDescription = result.signal
			? `received ${result.signal}`
			: `exited with ${result.status ?? "an unknown status"}`;
		throw new Error(`pnpm ${args.join(" ")} ${resultDescription}.`);
	}
}
