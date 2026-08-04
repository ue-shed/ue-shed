import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { cpus, platform, release, tmpdir, totalmem } from "node:os";
import { performance } from "node:perf_hooks";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	assetReaderLayer,
	scanSavedProject,
	SAVED_TABLE_SCAN_CLASSES,
	type AssetReaderProtocolObservation,
	type SavedAssetScan
} from "@ue-shed/unreal-assets";
import {
	ENHANCED_INPUT_CLASS_NAME_SUFFIXES,
	ENHANCED_INPUT_CLASS_PREFIX,
	scanEnhancedInputFromProjectIndex
} from "@ue-shed/enhanced-input";
import { Effect } from "effect";
import {
	DISPOSABLE_MARKER_CONTENT,
	DISPOSABLE_MARKER_FILE,
	resolveDisposableMutationTarget,
	withChangedPackage,
	withDeletedPackage,
	type DisposableMutationTarget
} from "./benchmark-project-index-support.js";
import {
	summarizeDurations,
	validateProjectIndexBenchmarkEvidence,
	type BenchmarkScenario,
	type BenchmarkScenarioSample
} from "./benchmark-project-index-result.js";

const repositoryRoot = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const defaultReader = join(
	repositoryRoot,
	"target",
	"release",
	process.platform === "win32" ? "uasset.exe" : "uasset"
);

interface BenchmarkOptions {
	readonly buildReader: boolean;
	readonly mutationProjectRoot?: string;
	readonly output?: string;
	readonly projectRoot: string;
	readonly reader: string;
	readonly runs: number;
	readonly warmups: number;
}

interface IndexObservation {
	readonly cacheHits: number;
	readonly emittedHeaders: number;
	readonly inputCandidates: number;
	readonly inventoryFiles: number;
	readonly packageFiles: number;
	readonly sidecarFiles: number;
}

type ScenarioSample = BenchmarkScenarioSample;
type ResourceObservation = Pick<
	ScenarioSample,
	| "cacheBytes"
	| "largestProtocolFrameBytes"
	| "nodePeakRssBytes"
	| "protocolBytes"
	| "rustPeakRssBytes"
>;

const usage = `Usage: pnpm benchmark:project-index -- --project <path> [options]

Measures the current Project Index baseline without recording project paths or asset identities.
The primary project is always read-only. Change/deletion scenarios require a separate disposable
project carrying an exact opt-in marker.

Options:
  --project <path>            Read-only Unreal project root containing Content (required)
  --mutation-project <path>   Separate disposable project for change/deletion scenarios
  --reader <path>             Compatible uasset executable (default target/release/uasset)
  --no-build                  Reuse the existing reader instead of building the release target
  --runs <count>              Timed samples per state (default 3)
  --warmups <count>           Untimed warmups for warm states (default 1)
  --output <path>             Write complete JSON evidence to this path
  --help                      Print this message

The mutation project must contain ${DISPOSABLE_MARKER_FILE} with this exact content:
${DISPOSABLE_MARKER_CONTENT}`;

function parsePositiveInteger(value: string, option: string): number {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isSafeInteger(parsed) || parsed < 1) {
		throw new Error(`${option} must be a positive integer.`);
	}
	return parsed;
}

function optionValue(arguments_: readonly string[], index: number, option: string): string {
	const value = arguments_[index + 1];
	if (value === undefined || value.startsWith("--")) {
		throw new Error(`${option} requires a value.`);
	}
	return value;
}

export function parseArguments(arguments_: readonly string[]): BenchmarkOptions | undefined {
	let mutationProjectRoot: string | undefined;
	let output: string | undefined;
	let projectRoot: string | undefined;
	let reader = defaultReader;
	let buildReader = true;
	let runs = 3;
	let warmups = 1;
	for (let index = 0; index < arguments_.length; index += 1) {
		const argument = arguments_[index];
		if (argument === "--") continue;
		if (argument === "--help") return undefined;
		if (argument === "--project") {
			projectRoot = resolve(repositoryRoot, optionValue(arguments_, index, argument));
			index += 1;
			continue;
		}
		if (argument === "--mutation-project") {
			mutationProjectRoot = resolve(repositoryRoot, optionValue(arguments_, index, argument));
			index += 1;
			continue;
		}
		if (argument === "--reader") {
			reader = resolve(repositoryRoot, optionValue(arguments_, index, argument));
			buildReader = false;
			index += 1;
			continue;
		}
		if (argument === "--no-build") {
			buildReader = false;
			continue;
		}
		if (argument === "--runs") {
			runs = parsePositiveInteger(optionValue(arguments_, index, argument), argument);
			index += 1;
			continue;
		}
		if (argument === "--warmups") {
			warmups = parsePositiveInteger(optionValue(arguments_, index, argument), argument);
			index += 1;
			continue;
		}
		if (argument === "--output") {
			output = resolve(repositoryRoot, optionValue(arguments_, index, argument));
			index += 1;
			continue;
		}
		throw new Error(`Unknown benchmark option: ${argument}`);
	}
	if (projectRoot === undefined) throw new Error("--project is required.");
	return {
		buildReader,
		...(mutationProjectRoot === undefined ? {} : { mutationProjectRoot }),
		...(output === undefined ? {} : { output }),
		projectRoot,
		reader,
		runs,
		warmups
	};
}

function roundMilliseconds(value: number): number {
	return Math.round(value * 1_000) / 1_000;
}

function gitContext(): { readonly dirty: boolean; readonly revision: string } {
	return {
		dirty:
			execFileSync("git", ["status", "--porcelain"], {
				cwd: repositoryRoot,
				encoding: "utf8"
			}).length > 0,
		revision: execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: repositoryRoot,
			encoding: "utf8"
		}).trim()
	};
}

function machineContext() {
	const processors = cpus();
	return {
		architecture: process.arch,
		cpuCount: processors.length,
		cpuModel: processors[0]?.model ?? "unknown",
		memoryBytes: totalmem(),
		nodeVersion: process.version,
		operatingSystem: `${platform()} ${release()}`,
		rustVersion: execFileSync("rustc", ["--version"], { encoding: "utf8" }).trim()
	};
}

function indexObservation(scan: SavedAssetScan): IndexObservation {
	if (scan.inventory === undefined || scan.summary.inventoryComplete !== true) {
		throw new Error("The reader did not return a complete project signature inventory.");
	}
	if (scan.inventory.length !== scan.summary.inventoryFiles) {
		throw new Error("Inventory line count did not match the terminal summary.");
	}
	const inputCandidates = scan.assets.filter(
		(entry) =>
			entry.depth === "header" &&
			entry.header.exports.some((exported) => {
				const classPath = exported.class_path;
				if (classPath === undefined) return false;
				const className = classPath.slice(classPath.lastIndexOf(".") + 1);
				return (
					classPath.startsWith(ENHANCED_INPUT_CLASS_PREFIX) ||
					ENHANCED_INPUT_CLASS_NAME_SUFFIXES.some((suffix) => className.endsWith(suffix))
				);
			})
	).length;
	return {
		cacheHits: scan.summary.cacheHits,
		emittedHeaders: scan.assets.length,
		inputCandidates,
		inventoryFiles: scan.inventory.length,
		packageFiles: scan.inventory.filter((entry) => entry.kind === "package").length,
		sidecarFiles: scan.inventory.filter((entry) => entry.kind === "sidecar").length
	};
}

function sampleProcessRss(pid: number, callback: (bytes: number | undefined) => void): void {
	if (process.platform === "win32") {
		execFile(
			"powershell",
			[
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				`$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($null -ne $p) { $p.WorkingSet64 }`
			],
			{ encoding: "utf8", windowsHide: true },
			(error, stdout) => {
				const value = Number.parseInt(stdout.trim(), 10);
				callback(error === null && Number.isSafeInteger(value) ? value : undefined);
			}
		);
		return;
	}
	execFile("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }, (error, stdout) => {
		const kibibytes = Number.parseInt(stdout.trim(), 10);
		callback(error === null && Number.isSafeInteger(kibibytes) ? kibibytes * 1_024 : undefined);
	});
}

class ResourceSampler {
	private activePid: number | undefined;
	private largestProtocolFrameBytes = 0;
	private nodePeakRssBytes = process.memoryUsage.rss();
	private outputBytes = 0;
	private pendingRustSample = false;
	private rustPeakRssBytes = 0;
	private stopped = false;
	private stopResolver: (() => void) | undefined;
	private readonly timer: NodeJS.Timeout;

	constructor() {
		this.timer = setInterval(() => this.sample(), 50);
	}

	readonly observe = (event: AssetReaderProtocolObservation): void => {
		if (event.kind === "worker_started") {
			this.activePid = event.pid;
			this.sample();
			return;
		}
		this.outputBytes += event.outputBytes;
		this.largestProtocolFrameBytes = Math.max(
			this.largestProtocolFrameBytes,
			event.largestFrameBytes
		);
		if (event.pid === this.activePid) this.activePid = undefined;
	};

	private sample(): void {
		this.nodePeakRssBytes = Math.max(this.nodePeakRssBytes, process.memoryUsage.rss());
		if (this.activePid === undefined || this.pendingRustSample) return;
		this.pendingRustSample = true;
		sampleProcessRss(this.activePid, (bytes) => {
			if (bytes !== undefined) this.rustPeakRssBytes = Math.max(this.rustPeakRssBytes, bytes);
			this.pendingRustSample = false;
			if (this.stopped) this.stopResolver?.();
		});
	}

	async stop(cachePath: string): Promise<ResourceObservation> {
		clearInterval(this.timer);
		this.stopped = true;
		this.sample();
		if (this.pendingRustSample) {
			await new Promise<void>((resolvePromise) => {
				this.stopResolver = resolvePromise;
			});
		}
		return {
			cacheBytes: existsSync(cachePath) ? statSync(cachePath).size : 0,
			largestProtocolFrameBytes: this.largestProtocolFrameBytes,
			nodePeakRssBytes: this.nodePeakRssBytes,
			protocolBytes: this.outputBytes,
			rustPeakRssBytes: this.rustPeakRssBytes === 0 ? null : this.rustPeakRssBytes
		};
	}
}

function headerIndex(
	options: BenchmarkOptions,
	cachePath: string,
	projectRoot: string,
	protocolObserver?: (event: AssetReaderProtocolObservation) => void
) {
	return scanSavedProject({
		cachePath,
		classes: SAVED_TABLE_SCAN_CLASSES,
		classNameSuffixes: ENHANCED_INPUT_CLASS_NAME_SUFFIXES,
		classPrefixes: [ENHANCED_INPUT_CLASS_PREFIX],
		depth: "header",
		inventory: true,
		projectRoot
	}).pipe(
		Effect.provide(
			assetReaderLayer({
				executable: options.reader,
				...(protocolObserver === undefined ? {} : { protocolObserver })
			})
		)
	);
}

async function runHeaderIndex(
	options: BenchmarkOptions,
	cachePath: string,
	projectRoot: string,
	protocolObserver?: (event: AssetReaderProtocolObservation) => void
): Promise<SavedAssetScan> {
	return Effect.runPromise(headerIndex(options, cachePath, projectRoot, protocolObserver));
}

function failureKind(cause: unknown): string {
	if (typeof cause === "object" && cause !== null && "kind" in cause) {
		const kind = cause.kind;
		if (typeof kind === "string") return kind;
	}
	return cause instanceof Error ? cause.name : "unknown";
}

async function observedSample(
	cachePath: string,
	operation: (
		observer: (event: AssetReaderProtocolObservation) => void
	) => Promise<{ readonly index: SavedAssetScan; readonly inputPackages?: number }>
): Promise<ScenarioSample> {
	const sampler = new ResourceSampler();
	const started = performance.now();
	try {
		const result = await operation(sampler.observe);
		return {
			...(await sampler.stop(cachePath)),
			durationMs: roundMilliseconds(performance.now() - started),
			index: indexObservation(result.index),
			...(result.inputPackages === undefined ? {} : { inputPackages: result.inputPackages })
		};
	} catch (cause) {
		return {
			...(await sampler.stop(cachePath)),
			durationMs: roundMilliseconds(performance.now() - started),
			failureKind: failureKind(cause)
		};
	}
}

async function runColdSample(
	options: BenchmarkOptions,
	cachePath: string
): Promise<ScenarioSample> {
	rmSync(cachePath, { force: true });
	return observedSample(cachePath, async (observer) => {
		const index = await runHeaderIndex(options, cachePath, options.projectRoot, observer);
		const input = await Effect.runPromise(
			scanEnhancedInputFromProjectIndex(index, { projectRoot: options.projectRoot }).pipe(
				Effect.provide(
					assetReaderLayer({ executable: options.reader, protocolObserver: observer })
				)
			)
		);
		return { index, inputPackages: input.coverage.inspectedPackages };
	});
}

async function runIndexSample(
	options: BenchmarkOptions,
	cachePath: string,
	projectRoot: string
): Promise<ScenarioSample> {
	return observedSample(cachePath, async (observer) => ({
		index: await runHeaderIndex(options, cachePath, projectRoot, observer)
	}));
}

function scenario(samples: readonly ScenarioSample[], notes: string): BenchmarkScenario {
	const failureKinds = [
		...new Set(
			samples.flatMap((sample) =>
				sample.failureKind === undefined ? [] : [sample.failureKind]
			)
		)
	];
	return {
		distribution: summarizeDurations(samples.map((sample) => sample.durationMs)),
		failureKinds,
		notes,
		samples,
		status: failureKinds.length === 0 ? ("completed" as const) : ("failed" as const)
	};
}

function prepareReader(options: BenchmarkOptions): void {
	if (options.buildReader) {
		execFileSync("cargo", ["build", "--locked", "--release", "-p", "uasset-io"], {
			cwd: repositoryRoot,
			stdio: "inherit",
			windowsHide: true
		});
	}
	if (!existsSync(options.reader)) throw new Error("Reader executable was not found.");
}

async function repeated(
	runs: number,
	operation: (iteration: number) => Promise<ScenarioSample>
): Promise<readonly ScenarioSample[]> {
	const samples: ScenarioSample[] = [];
	for (let iteration = 0; iteration < runs; iteration += 1) {
		samples.push(await operation(iteration));
	}
	return samples;
}

function writeResult(path: string, result: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(result, null, "\t")}\n`, "utf8");
}

async function mutationScenarios(
	options: BenchmarkOptions,
	cachePath: string,
	target: DisposableMutationTarget
) {
	const seed = () => runHeaderIndex(options, cachePath, target.root);
	rmSync(cachePath, { force: true });
	await seed();
	const changed = await repeated(options.runs, async () => {
		await seed();
		return withChangedPackage(target, () => runIndexSample(options, cachePath, target.root));
	});
	const deleted = await repeated(options.runs, async () => {
		await seed();
		return withDeletedPackage(target, () => runIndexSample(options, cachePath, target.root));
	});
	return {
		"project_index.one_changed_package": scenario(
			changed,
			"One package timestamp changes in an explicitly marked disposable project. The package bytes are unchanged and its timestamp is restored after every sample."
		),
		"project_index.one_deleted_package": scenario(
			deleted,
			"One package and its sidecars are temporarily renamed in an explicitly marked disposable project and restored after every sample."
		)
	};
}

export async function main(arguments_: readonly string[] = process.argv.slice(2)): Promise<void> {
	const options = parseArguments(arguments_);
	if (options === undefined) {
		process.stdout.write(usage);
		return;
	}
	prepareReader(options);
	if (!existsSync(join(options.projectRoot, "Content"))) {
		throw new Error("--project must contain a Content directory.");
	}
	const mutationTarget =
		options.mutationProjectRoot === undefined
			? undefined
			: await resolveDisposableMutationTarget({
					mutationProjectRoot: options.mutationProjectRoot,
					primaryProjectRoot: options.projectRoot
				});
	const cachePrefix = `ue-shed-project-index-benchmark-${process.pid}-${Date.now()}`;
	const primaryCachePath = join(tmpdir(), `${cachePrefix}-primary.json`);
	const mutationCachePath = join(tmpdir(), `${cachePrefix}-mutation.json`);
	try {
		const cold = await repeated(options.runs, () => runColdSample(options, primaryCachePath));
		await runHeaderIndex(options, primaryCachePath, options.projectRoot).catch(() => undefined);
		for (let iteration = 0; iteration < options.warmups; iteration += 1) {
			await runHeaderIndex(options, primaryCachePath, options.projectRoot).catch(
				() => undefined
			);
		}
		const warm = await repeated(options.runs, () =>
			runIndexSample(options, primaryCachePath, options.projectRoot)
		);
		const mutations =
			mutationTarget === undefined
				? {}
				: await mutationScenarios(options, mutationCachePath, mutationTarget);
		const result = {
			schemaVersion: 2,
			generatedAt: new Date().toISOString(),
			configuration: {
				mutationScenarios:
					mutationTarget === undefined ? "not_requested" : "disposable_project",
				reader: basename(options.reader),
				readerBuild: options.buildReader ? ("performed" as const) : ("skipped" as const),
				runs: options.runs,
				warmups: options.warmups
			},
			git: gitContext(),
			machine: machineContext(),
			scenarios: {
				"project_index.cold_build": scenario(
					cold,
					"The legacy header cache is removed before every sample. The sample includes the shared header inventory and targeted Enhanced Input decode."
				),
				"project_index.warm_noop": scenario(
					warm,
					"The legacy header cache is populated. This baseline still enumerates and transmits the complete inventory."
				),
				...mutations
			}
		};
		const evidence = validateProjectIndexBenchmarkEvidence(result, [
			options.projectRoot,
			...(mutationTarget === undefined
				? []
				: [mutationTarget.root, mutationTarget.packagePath, ...mutationTarget.relatedPaths])
		]);
		if (options.output !== undefined) writeResult(options.output, evidence);
		process.stdout.write(`${JSON.stringify(evidence, null, "\t")}\n`);
	} finally {
		rmSync(primaryCachePath, { force: true });
		rmSync(mutationCachePath, { force: true });
	}
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && fileURLToPath(import.meta.url) === resolve(entrypoint)) {
	await main();
}
