import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { cpus, platform, release, tmpdir, totalmem } from "node:os";
import { performance } from "node:perf_hooks";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	assetReaderLayer,
	scanSavedProject,
	SAVED_TABLE_SCAN_CLASSES,
	type SavedAssetScan
} from "@ue-shed/unreal-assets";
import {
	ENHANCED_INPUT_CLASS_NAME_SUFFIXES,
	ENHANCED_INPUT_CLASS_PREFIX,
	scanEnhancedInputFromProjectIndex
} from "@ue-shed/enhanced-input";
import { Effect } from "effect";

const repositoryRoot = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const defaultReader = join(
	repositoryRoot,
	"target",
	"release",
	process.platform === "win32" ? "uasset.exe" : "uasset"
);

interface BenchmarkOptions {
	readonly output?: string;
	readonly projectRoot: string;
	readonly reader: string;
	readonly runs: number;
	readonly warmups: number;
}

interface Distribution {
	readonly count: number;
	readonly maxMs: number;
	readonly meanMs: number;
	readonly minMs: number;
	readonly p50Ms: number;
	readonly p95Ms: number;
	readonly samplesMs: readonly number[];
}

interface IndexObservation {
	readonly emittedHeaders: number;
	readonly inputCandidates: number;
	readonly inventoryFiles: number;
	readonly packageFiles: number;
	readonly sidecarFiles: number;
}

const usage = `Usage: pnpm benchmark:project-index -- --project <path> [options]

Measures the same native header-index and targeted Enhanced Input decode path Workbench uses.
The project root is used only for the run; JSON output records aggregate counts, never the path.

Options:
  --project <path>   Unreal project root containing Content (required)
  --reader <path>    Compatible uasset executable (default target/release/uasset)
  --runs <count>     Timed samples per state (default 3)
  --warmups <count>  Untimed warmups for the warm-cache state (default 1)
  --output <path>    Write complete JSON evidence to this path
  --help             Print this message
`;

function parsePositiveInteger(value: string, option: string): number {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isSafeInteger(parsed) || parsed < 1) {
		throw new Error(`${option} must be a positive integer.`);
	}
	return parsed;
}

function optionValue(arguments_: readonly string[], index: number, option: string): string {
	const value = arguments_[index + 1];
	if (value === undefined || value.startsWith("--"))
		throw new Error(`${option} requires a value.`);
	return value;
}

function parseArguments(arguments_: readonly string[]): BenchmarkOptions | undefined {
	let output: string | undefined;
	let projectRoot: string | undefined;
	let reader = defaultReader;
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
		if (argument === "--reader") {
			reader = resolve(repositoryRoot, optionValue(arguments_, index, argument));
			index += 1;
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
	return { ...(output === undefined ? {} : { output }), projectRoot, reader, runs, warmups };
}

function roundMilliseconds(value: number): number {
	return Math.round(value * 1_000) / 1_000;
}

function percentile(sorted: readonly number[], fraction: number): number {
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
	return sorted[index] ?? 0;
}

function distribution(samples: readonly number[]): Distribution {
	const sorted = [...samples].sort((left, right) => left - right);
	const sum = samples.reduce((total, value) => total + value, 0);
	return {
		count: samples.length,
		maxMs: roundMilliseconds(sorted.at(-1) ?? 0),
		meanMs: roundMilliseconds(sum / samples.length),
		minMs: roundMilliseconds(sorted[0] ?? 0),
		p50Ms: roundMilliseconds(percentile(sorted, 0.5)),
		p95Ms: roundMilliseconds(percentile(sorted, 0.95)),
		samplesMs: samples.map(roundMilliseconds)
	};
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
		throw new Error(
			`Inventory line count ${scan.inventory.length} did not match summary ${scan.summary.inventoryFiles}.`
		);
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
		emittedHeaders: scan.assets.length,
		inputCandidates,
		inventoryFiles: scan.inventory.length,
		packageFiles: scan.inventory.filter((entry) => entry.kind === "package").length,
		sidecarFiles: scan.inventory.filter((entry) => entry.kind === "sidecar").length
	};
}

function headerIndex(options: BenchmarkOptions, cachePath: string): Effect.Effect<SavedAssetScan> {
	return scanSavedProject({
		cachePath,
		classes: SAVED_TABLE_SCAN_CLASSES,
		classNameSuffixes: ENHANCED_INPUT_CLASS_NAME_SUFFIXES,
		classPrefixes: [ENHANCED_INPUT_CLASS_PREFIX],
		depth: "header",
		inventory: true,
		projectRoot: options.projectRoot
	}).pipe(Effect.provide(assetReaderLayer({ executable: options.reader })));
}

async function runHeaderIndex(
	options: BenchmarkOptions,
	cachePath: string
): Promise<SavedAssetScan> {
	return Effect.runPromise(headerIndex(options, cachePath));
}

async function runColdRebuild(
	options: BenchmarkOptions,
	cachePath: string
): Promise<{ readonly inputPackages: number; readonly observation: IndexObservation }> {
	rmSync(cachePath, { force: true });
	const scan = await runHeaderIndex(options, cachePath);
	const input = await Effect.runPromise(
		scanEnhancedInputFromProjectIndex(scan, { projectRoot: options.projectRoot }).pipe(
			Effect.provide(assetReaderLayer({ executable: options.reader }))
		)
	);
	return { inputPackages: input.coverage.inspectedPackages, observation: indexObservation(scan) };
}

async function measure(runs: number, operation: () => Promise<void>): Promise<Distribution> {
	const samples: number[] = [];
	for (let iteration = 0; iteration < runs; iteration += 1) {
		const started = performance.now();
		await operation();
		samples.push(performance.now() - started);
	}
	return distribution(samples);
}

function writeResult(path: string, result: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(result, null, "\t")}\n`, "utf8");
}

async function main(): Promise<void> {
	const options = parseArguments(process.argv.slice(2));
	if (options === undefined) {
		process.stdout.write(usage);
		return;
	}
	if (!existsSync(options.reader))
		throw new Error(`Reader executable was not found: ${options.reader}`);
	if (!existsSync(join(options.projectRoot, "Content"))) {
		throw new Error("--project must contain a Content directory.");
	}

	const cachePath = join(
		tmpdir(),
		`ue-shed-project-index-benchmark-${process.pid}-${Date.now()}.json`
	);
	try {
		const coldSample = await runColdRebuild(options, cachePath);
		const coldRebuild = await measure(options.runs, async () => {
			await runColdRebuild(options, cachePath);
		});

		await runHeaderIndex(options, cachePath);
		for (let iteration = 0; iteration < options.warmups; iteration += 1) {
			await runHeaderIndex(options, cachePath);
		}
		const warmRevalidate = await measure(options.runs, async () => {
			await runHeaderIndex(options, cachePath);
		});

		const result = {
			schemaVersion: 1,
			generatedAt: new Date().toISOString(),
			configuration: {
				coldHeaderCache: true,
				reader: basename(options.reader),
				runs: options.runs,
				warmups: options.warmups
			},
			git: gitContext(),
			machine: machineContext(),
			observation: coldSample.observation,
			scenarios: {
				"workbench.index.cold_rebuild": {
					distribution: coldRebuild,
					inputPackages: coldSample.inputPackages,
					notes:
						"One native header index plus the actual targeted Enhanced Input decode. " +
						"The native header cache is removed before every sample; filesystem caches remain warm."
				},
				"workbench.index.warm_revalidate": {
					distribution: warmRevalidate,
					notes:
						"One native index refresh with a populated header cache. It still enumerates and " +
						"stats the selected roots, streams the complete inventory, and does not decode Input Atlas."
				}
			}
		};
		if (options.output !== undefined) writeResult(options.output, result);
		process.stdout.write(`${JSON.stringify(result, null, "\t")}\n`);
	} finally {
		rmSync(cachePath, { force: true });
	}
}

await main();
