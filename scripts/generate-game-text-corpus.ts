import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync
} from "node:fs";
import { userInfo, availableParallelism } from "node:os";
import { dirname } from "node:path";
import {
	corpusLocalization,
	corpusPlanName,
	decodeCorpusPlan
} from "../packages/game-text-corpus/dist/index.js";
import { planCorpus } from "./game-text-corpus-plan.ts";
import { prepareCorpusOutput, writeCorpusOwnership } from "./game-text-corpus-ownership.ts";
import { basename, join, relative } from "node:path";
import { performance } from "node:perf_hooks";
import {
	corpusContentFolder,
	corpusManifestName,
	decodeCorpusManifest,
	parseCorpusArguments,
	summarizeCorpusManifest
} from "./game-text-corpus.ts";
import { isJsonString, parseJsonObject } from "./json.ts";
import { associatedUnrealEngine } from "./unreal-engines.ts";
import {
	localDerivedDataCacheArguments,
	repositoryRoot,
	unrealEngineTools,
	unrealEngineVersion
} from "./unreal-plugin-host.ts";
import { assertCorpusScratch, createCorpusScratch } from "./game-text-corpus-scratch.ts";
import { parseUnrealDescriptor } from "./unreal-project-support.ts";
import { withCorpusUnrealLock } from "./game-text-corpus-lock.ts";

const pluginName = "UEShedCorpusGenerator";
const pluginSource = join(repositoryRoot, "tools", "unreal", pluginName);
const buildCompleteMarker = ".ue-shed-build-complete";

function filesUnder(root: string): string[] {
	return readdirSync(root, { withFileTypes: true, recursive: true })
		.filter((entry) => entry.isFile())
		.map((entry) => join(entry.parentPath, entry.name));
}

async function run(log: string, command: string, args: readonly string[]) {
	await withCorpusUnrealLock(() => runLocked(log, command, args));
}
function runLocked(log: string, command: string, args: readonly string[]) {
	const batch = /\.(bat|cmd)$/iu.test(command);
	const executable = batch
		? [command, ...args].map((argument) => `"${argument.replaceAll('"', '""')}"`).join(" ")
		: command;
	const descriptor = openSync(log, "w");
	try {
		const result = spawnSync(executable, batch ? [] : args, {
			cwd: repositoryRoot,
			env: {
				...process.env,
				UnrealBuildTool_BuildConfiguration__MaxParallelActions: String(
					Math.max(1, Math.min(8, Math.floor(availableParallelism() / 2)))
				)
			},
			shell: batch,
			stdio: ["ignore", descriptor, descriptor],
			windowsHide: true
		});
		if (result.error) throw result.error;
		if (result.status !== 0) {
			const tail = readFileSync(log, "utf8").split(/\r?\n/u).slice(-30).join("\n");
			throw new Error(
				`${basename(command)} exited with ${result.status}; see ${log}\n${tail}`
			);
		}
	} finally {
		closeSync(descriptor);
	}
}

/** Builds the plugin for one engine once per source revision, under out/. */
async function buildPlugin(engineRoot: string, label: string) {
	const editorManifest = parseJsonObject(
		readFileSync(
			join(engineRoot, "Engine", "Binaries", "Win64", "UnrealEditor.modules"),
			"utf8"
		)
	);
	const buildId = isJsonString(editorManifest.BuildId) ? editorManifest.BuildId : "";
	if (!buildId) throw new Error(`${engineRoot} has no editor build ID. Build its Editor first.`);
	const hash = createHash("sha256")
		.update(realpathSync(engineRoot).toLowerCase())
		.update(`\0${buildId}\0`);
	for (const file of filesUnder(pluginSource)
		.map((path) => relative(pluginSource, path).replaceAll("\\", "/"))
		.filter((path) => !/^(Binaries|Intermediate)\//u.test(path))
		.sort()) {
		hash.update(`${file}\0`)
			.update(readFileSync(join(pluginSource, file)))
			.update("\0");
	}
	const parent = join(repositoryRoot, "out", "game-text-corpus-plugin", label);
	const packageRoot = join(parent, hash.digest("hex").slice(0, 16));
	const descriptor = join(packageRoot, `${pluginName}.uplugin`);
	if (existsSync(join(packageRoot, buildCompleteMarker))) return { descriptor, built: false };
	rmSync(packageRoot, { recursive: true, force: true });
	mkdirSync(parent, { recursive: true });
	const log = `${packageRoot}-build.log`;
	process.stdout.write(`Building ${pluginName} for Unreal ${label} (log: ${log})\n`);
	await run(log, join(engineRoot, "Engine", "Build", "BatchFiles", "RunUAT.bat"), [
		"BuildPlugin",
		`-Plugin=${join(pluginSource, `${pluginName}.uplugin`)}`,
		`-Package=${packageRoot}`,
		"-NoTargetPlatforms",
		"-NoP4",
		"-Unattended"
	]);
	if (!existsSync(descriptor)) throw new Error(`BuildPlugin did not write ${descriptor}.`);
	writeFileSync(join(packageRoot, buildCompleteMarker), `${buildId}\n`);
	return { descriptor, built: true };
}

/** The project's engine: --engine-root, else the engine its EngineAssociation names. */
async function projectEngineRoot(project: string, explicitRoot: string | undefined) {
	if (explicitRoot !== undefined) return explicitRoot;
	const association = existsSync(project)
		? parseUnrealDescriptor(readFileSync(project, "utf8")).EngineAssociation
		: "5.8";
	const label = isJsonString(association) ? association : undefined;
	const root = await associatedUnrealEngine(label);
	if (root === undefined || !existsSync(root)) {
		throw new Error(
			`Could not find the engine for EngineAssociation "${label ?? ""}". Pass --engine-root.`
		);
	}
	return root;
}

const options = parseCorpusArguments(process.argv.slice(2), userInfo().username);
assertCorpusScratch(options.project);
const engineRoot = await projectEngineRoot(options.project, options.engineRoot);
const version = unrealEngineVersion(engineRoot);
if (!version || version.major !== 5) {
	throw new Error(`The corpus generator needs Unreal Engine 5; ${engineRoot} is not.`);
}
createCorpusScratch(options.project, version.label);
process.stdout.write(`Unreal ${version.label}: ${engineRoot}\n`);
const folder = corpusContentFolder(options.project, options.root);
const plan = planCorpus({ ...options, phase: options.patch ? "after" : "initial" });
if (options.patch && !existsSync(join(folder, corpusManifestName)))
	throw new Error("--patch needs a generated corpus.");
if (options.patch) {
	const previous = decodeCorpusPlan(readFileSync(join(folder, corpusPlanName), "utf8"));
	if (
		previous.seed !== plan.seed ||
		previous.requestedLines !== plan.requestedLines ||
		previous.density !== plan.density ||
		previous.root !== plan.root ||
		previous.scenario !== plan.scenario
	)
		throw new Error("--patch must use the original seed, line count, root and scenario.");
}

prepareCorpusOutput(
	dirname(options.project),
	folder,
	plan.target,
	options.patch || options.clean,
	!options.patch
);

const buildStarted = performance.now();
const plugin = await buildPlugin(engineRoot, version.label);
const buildSeconds = (performance.now() - buildStarted) / 1000;
process.stdout.write(
	plugin.built
		? `Built the plugin in ${buildSeconds.toFixed(1)} s: ${plugin.descriptor}\n`
		: `Using the cached plugin build: ${plugin.descriptor}\n`
);

const runs = join(repositoryRoot, "out", "game-text-corpus-runs");
mkdirSync(runs, { recursive: true });
const runLog = join(runs, `${basename(options.project, ".uproject")}-${Date.now()}.log`);
process.stdout.write(`Generating ${options.lines} lines (seed ${options.seed}); log: ${runLog}\n`);
const generateStarted = performance.now();
const planPath = join(dirname(options.project), "Saved", "UEShedCorpus", corpusPlanName);
mkdirSync(dirname(planPath), { recursive: true });
const wirePlan = {
	...plan,
	packages: plan.packages.map((item) => ({ ...item, lines: item.texts.length })),
	localization: corpusLocalization(plan)
};
writeFileSync(planPath, JSON.stringify(wirePlan, null, "\t"));
await run(runLog, unrealEngineTools(engineRoot).editorCommandlet, [
	options.project,
	"-run=UEShedGameTextCorpus",
	`-Plan=${planPath}`,
	...(options.patch ? ["-Patch"] : []),
	`-PLUGIN=${plugin.descriptor}`,
	`-ABSLOG=${runLog.replace(/\.log$/u, "-editor.log")}`,
	"-unattended",
	"-nullrhi",
	"-nosplash",
	"-SCCProvider=None",
	...localDerivedDataCacheArguments,
	"-UTF8Output"
]);
writeFileSync(join(folder, corpusPlanName), readFileSync(planPath));
writeCorpusOwnership(dirname(options.project), folder, plan.target);
const generateSeconds = (performance.now() - generateStarted) / 1000;
const manifest = decodeCorpusManifest(readFileSync(join(folder, corpusManifestName), "utf8"));
process.stdout.write(`${summarizeCorpusManifest(manifest)}\n`);
process.stdout.write(
	`Plugin build: ${plugin.built ? `${buildSeconds.toFixed(1)} s` : "cached"}; ` +
		`generation: ${generateSeconds.toFixed(1)} s\nFolder: ${folder}\n`
);
if (options.scenario === "main" && !options.patch) {
	const probeProject = join(
		dirname(options.project),
		"Saved",
		"UEShedCorpus",
		"CollapseProbe",
		"Corpus.uproject"
	);
	createCorpusScratch(probeProject, version.label);
	const probe = spawnSync(
		process.execPath,
		[
			join(repositoryRoot, "scripts", "generate-game-text-corpus.ts"),
			"--project",
			probeProject,
			"--root",
			options.root,
			"--seed",
			String(options.seed),
			"--lines",
			"1",
			"--engine-root",
			engineRoot,
			"--scenario",
			"collapse",
			"--density",
			"1",
			...(options.clean ? ["--clean"] : [])
		],
		{ stdio: "inherit", windowsHide: true }
	);
	if (probe.error) throw probe.error;
	if (probe.status !== 0) throw new Error(`Collapse probe generation failed (${probe.status}).`);
}
