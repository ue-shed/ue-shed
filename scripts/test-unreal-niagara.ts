import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Effect } from "effect";
import {
	EngineInstallationDiscovery,
	EngineInstallationDiscoveryLive
} from "../packages/engine/src/index.ts";
import { runNiagaraPreview } from "../packages/niagara/src/index.ts";
import { prepareUnrealPlugins, unrealEngineTools } from "./unreal-plugin-host.ts";
import { repositoryRoot } from "./native-tools.ts";

const projectDescriptor = join(
	repositoryRoot,
	"fixtures",
	"unreal-project",
	"UEShedFixture.uproject"
);

function run(command: string, args: readonly string[]) {
	const result = spawnSync(command, args, {
		cwd: repositoryRoot,
		stdio: "inherit",
		windowsHide: true
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(`${command} ${args.join(" ")} exited with ${String(result.status)}.`);
	}
}

function prepareSupervisor() {
	run("cargo", ["build", "--locked", "-p", "engine-process-supervisor"]);
	const targetRoot = process.env.CARGO_TARGET_DIR
		? resolve(repositoryRoot, process.env.CARGO_TARGET_DIR)
		: join(repositoryRoot, "target");
	run(process.execPath, [
		join(repositoryRoot, "packages", "engine-win32-x64", "scripts", "assemble.mts"),
		"--source",
		join(targetRoot, "debug", "ue-shed-process-supervisor.exe")
	]);
}

const installation = await Effect.runPromise(
	Effect.flatMap(EngineInstallationDiscovery, (service) =>
		service.resolve({
			projectDescriptor,
			...(process.env.UE_SHED_UNREAL_ENGINE_ROOT === undefined
				? undefined
				: { explicitRoot: process.env.UE_SHED_UNREAL_ENGINE_ROOT })
		})
	).pipe(Effect.provide(EngineInstallationDiscoveryLive))
);

prepareSupervisor();
const pluginDescriptor = prepareUnrealPlugins({
	engineRoot: installation.root,
	projectPath: projectDescriptor,
	tools: unrealEngineTools(installation.root)
}).find((path) => path.endsWith("UEShedNiagara.uplugin"));
if (pluginDescriptor === undefined) throw new Error("UEShedNiagara was not staged.");

const outputRoot = await mkdtemp(join(tmpdir(), "ue-shed-niagara-conformance-"));
try {
	const outcome = await Effect.runPromise(
		runNiagaraPreview({
			explicitEngineRoot: installation.root,
			outputRoot,
			pluginDescriptor,
			projectDescriptor,
			settings: {
				durationSeconds: 1,
				frameCount: 2,
				height: 64,
				simulationFramesPerSecond: 60,
				startSeconds: 0,
				width: 64
			},
			systemObjectPath:
				"/Niagara/DefaultAssets/Templates/Systems/SimpleExplosion.SimpleExplosion"
		})
	);
	if (outcome.manifest.artifacts.length !== 2) {
		throw new Error("Niagara conformance did not publish exactly two frames.");
	}
	if (!outcome.manifest.artifacts.some((frame) => frame.nonTransparentPixelFraction > 0)) {
		throw new Error("Niagara conformance produced no visible pixels.");
	}
	if (outcome.manifest.effectiveSettings.captureMode !== "component_only") {
		throw new Error("Niagara conformance did not preserve component-only default capture.");
	}
	console.log(
		`Niagara trusted conformance passed with ${outcome.manifest.artifacts.length} hashed frames on Unreal ${outcome.manifest.producer.engineVersion}.`
	);
} finally {
	await rm(outputRoot, { force: true, recursive: true });
}
