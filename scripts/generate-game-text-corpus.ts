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
import { userInfo } from "node:os";
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
import { repositoryRoot, unrealEngineTools, unrealEngineVersion } from "./unreal-plugin-host.ts";
import {
	installedEngineRoot,
	parseUnrealDescriptor,
	registeredEngineRoot
} from "./unreal-project-support.ts";

const pluginName = "UEShedCorpusGenerator";
const pluginSource = join(repositoryRoot, "tools", "unreal", pluginName);
const buildCompleteMarker = ".ue-shed-build-complete";

function filesUnder(root: string): string[] {
	return readdirSync(root, { withFileTypes: true, recursive: true })
		.filter((entry) => entry.isFile())
		.map((entry) => join(entry.parentPath, entry.name));
}

function run(log: string, command: string, args: readonly string[]) {
	const batch = /\.(bat|cmd)$/iu.test(command);
	const executable = batch
		? [command, ...args].map((argument) => `"${argument.replaceAll('"', '""')}"`).join(" ")
		: command;
	const descriptor = openSync(log, "w");
	try {
		const result = spawnSync(executable, batch ? [] : args, {
			cwd: repositoryRoot,
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
function buildPlugin(engineRoot: string, label: string) {
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
	run(log, join(engineRoot, "Engine", "Build", "BatchFiles", "RunUAT.bat"), [
		"BuildPlugin",
		`-Plugin=${join(pluginSource, `${pluginName}.uplugin`)}`,
		`-Package=${packageRoot}`,
		"-TargetPlatforms=Win64",
		"-NoP4",
		"-Unattended"
	]);
	if (!existsSync(descriptor)) throw new Error(`BuildPlugin did not write ${descriptor}.`);
	writeFileSync(join(packageRoot, buildCompleteMarker), `${buildId}\n`);
	return { descriptor, built: true };
}

/** The project's engine: --engine-root, else its EngineAssociation in Unreal's registry keys. */
function projectEngineRoot(project: string, explicitRoot: string | undefined) {
	if (explicitRoot !== undefined) return explicitRoot;
	const association = parseUnrealDescriptor(readFileSync(project, "utf8")).EngineAssociation;
	const label = isJsonString(association) ? association : undefined;
	// A "5.7" association names a launcher install; anything else a registered source build.
	const root =
		label !== undefined && /^\d+\.\d+$/u.test(label)
			? installedEngineRoot({ version: label })
			: registeredEngineRoot({ association: label });
	if (root === undefined || !existsSync(root)) {
		throw new Error(
			`Could not find the engine for EngineAssociation "${label ?? ""}". Pass --engine-root.`
		);
	}
	return root;
}

/** Empties the corpus folder only when it holds a corpus: its manifest and saved packages. */
function prepareOutputFolder(folder: string, clean: boolean) {
	if (!existsSync(folder)) return;
	const files = filesUnder(folder);
	if (files.length === 0) return;
	const manifestPath = join(folder, corpusManifestName);
	if (!existsSync(manifestPath)) {
		throw new Error(`${folder} has files but no ${corpusManifestName}. Choose another --root.`);
	}
	if (!clean) throw new Error(`${folder} already holds a corpus. Pass --clean to replace it.`);
	decodeCorpusManifest(readFileSync(manifestPath, "utf8"));
	const foreign = files.filter((file) => file !== manifestPath && !file.endsWith(".uasset"));
	if (foreign.length > 0) {
		throw new Error(
			`--clean stopped: ${folder} holds files the generator did not write:\n` +
				foreign.slice(0, 10).join("\n")
		);
	}
	rmSync(folder, { recursive: true });
	process.stdout.write(`Removed the previous corpus in ${folder}\n`);
}

const options = parseCorpusArguments(process.argv.slice(2), userInfo().username);
if (!existsSync(options.project)) throw new Error(`No project at ${options.project}.`);
const engineRoot = projectEngineRoot(options.project, options.engineRoot);
const version = unrealEngineVersion(engineRoot);
if (!version || version.major < 5) {
	throw new Error(`The corpus generator needs Unreal Engine 5; ${engineRoot} is not.`);
}
process.stdout.write(`Unreal ${version.label}: ${engineRoot}\n`);
const folder = corpusContentFolder(options.project, options.root);
prepareOutputFolder(folder, options.clean);

const buildStarted = performance.now();
const plugin = buildPlugin(engineRoot, version.label);
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
run(runLog, unrealEngineTools(engineRoot).editorCommandlet, [
	options.project,
	"-run=UEShedGameTextCorpus",
	`-Lines=${options.lines}`,
	`-Seed=${options.seed}`,
	`-Root=${options.root}`,
	`-PLUGIN=${plugin.descriptor}`,
	`-ABSLOG=${runLog.replace(/\.log$/u, "-editor.log")}`,
	"-unattended",
	"-nullrhi",
	"-nosplash",
	"-nop4",
	"-UTF8Output"
]);
const generateSeconds = (performance.now() - generateStarted) / 1000;
const manifest = decodeCorpusManifest(readFileSync(join(folder, corpusManifestName), "utf8"));
process.stdout.write(`${summarizeCorpusManifest(manifest)}\n`);
process.stdout.write(
	`Plugin build: ${plugin.built ? `${buildSeconds.toFixed(1)} s` : "cached"}; ` +
		`generation: ${generateSeconds.toFixed(1)} s\nFolder: ${folder}\n`
);
