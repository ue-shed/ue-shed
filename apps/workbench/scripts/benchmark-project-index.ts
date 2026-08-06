import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { cpus, platform, release, tmpdir, totalmem } from "node:os";
import { performance } from "node:perf_hooks";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	ProjectIndexQuery,
	PROJECT_INDEX_MAX_PAGE_SIZE,
	SAVED_TABLE_SCAN_CLASSES,
	assetReaderLayer,
	foldProjectIndexRefresh,
	projectIndexProcessLayer,
	queryProjectIndex,
	refreshProjectIndex,
	type AssetReaderProtocolObservation,
	type ProjectIndexCursor,
	type ProjectIndexError,
	type ProjectIndexHeader,
	type ProjectIndexPage,
	type ProjectIndex,
	type ProjectIndexQuery as ProjectIndexQueryValue,
	type ProjectIndexSummary,
	type SavedAssetScan
} from "@ue-shed/unreal-assets";
import { STRING_TABLE_CLASS, TEXT_PROPERTY_NAME } from "@ue-shed/game-text";
import { TEXTURE_CLASS } from "@ue-shed/asset-audits";
import {
	ENHANCED_INPUT_CLASS_NAME_SUFFIXES,
	ENHANCED_INPUT_CLASS_PREFIX,
	scanEnhancedInputFromProjectIndex
} from "@ue-shed/enhanced-input";
import { Effect, Layer, Stream } from "effect";
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
	readonly changedPackages: number;
	readonly emittedHeaders: number;
	readonly generation: number;
	readonly inputCandidates: number;
	readonly mapCount: number;
	readonly packageCount: number;
	readonly queryPages: number;
	readonly removedPackages: number;
}

interface NativeRefreshTiming {
	readonly committingMs: number;
	readonly comparingMs: number;
	readonly committedEvidenceRows: number;
	readonly durationMs: number;
	readonly enumeratingMs: number;
	readonly evidenceWriteMs: number;
	readonly headerReads: number;
	readonly headerProcessingExcludingEvidenceWritesMs: number;
	readonly removedEvidenceRows: number;
	readonly readingHeadersMs: number;
	readonly stagedEvidenceRows: number;
}

interface PhaseTiming {
	readonly foldingMs: number;
	readonly inputDecodeMs?: number;
	readonly native: NativeRefreshTiming;
	readonly queryMs: number;
	readonly refreshMs: number;
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

interface ProjectIndexSample {
	readonly index: SavedAssetScan;
	readonly inputPackages?: number;
	readonly queryPages: number;
	readonly summary: ProjectIndexSummary;
	readonly timings: PhaseTiming;
}

const PROJECT_INDEX_TIMEOUT_MS = 5 * 60_000;

const usage = `Usage: pnpm benchmark:project-index -- --project <path> [options]

Measures the production DuckDB-backed Project Index without recording project paths or asset identities.
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

function cacheBytes(root: string): number {
	if (!existsSync(root)) return 0;
	const entry = statSync(root);
	if (!entry.isDirectory()) return entry.size;
	return readdirSync(root, { withFileTypes: true }).reduce((total, child) => {
		const path = join(root, child.name);
		return total + (child.isDirectory() ? cacheBytes(path) : statSync(path).size);
	}, 0);
}

function nativeRefreshTiming(message: string): NativeRefreshTiming | undefined {
	const read = (key: string): number | undefined => {
		const match = new RegExp(`${key}=(\\d+)`).exec(message);
		if (match === null) return undefined;
		const value = Number(match[1]);
		return Number.isSafeInteger(value) ? value : undefined;
	};
	const committingMs = read("committing_ms");
	const comparingMs = read("comparing_ms");
	const committedEvidenceRows = read("committed_rows");
	const durationMs = read("duration_ms");
	const enumeratingMs = read("enumerating_ms");
	const evidenceWriteMs = read("evidence_write_ms");
	const headerReads = read("changed");
	const removedEvidenceRows = read("removed_rows");
	const readingHeadersMs = read("reading_headers_ms");
	const stagedEvidenceRows = read("staged_rows");
	if (
		committingMs === undefined ||
		comparingMs === undefined ||
		committedEvidenceRows === undefined ||
		durationMs === undefined ||
		enumeratingMs === undefined ||
		evidenceWriteMs === undefined ||
		headerReads === undefined ||
		removedEvidenceRows === undefined ||
		readingHeadersMs === undefined ||
		stagedEvidenceRows === undefined
	)
		return undefined;
	return {
		committingMs,
		comparingMs,
		committedEvidenceRows,
		durationMs,
		enumeratingMs,
		evidenceWriteMs,
		headerReads,
		headerProcessingExcludingEvidenceWritesMs: Math.max(0, readingHeadersMs - evidenceWriteMs),
		removedEvidenceRows,
		readingHeadersMs,
		stagedEvidenceRows
	};
}

function headerScanFromProjectIndex(
	projectRoot: string,
	summary: ProjectIndexSummary,
	items: readonly ProjectIndexHeader[]
): SavedAssetScan {
	const headers = new Map<
		string,
		{ readonly classes: Set<string>; readonly packageName: string; readonly names: Set<string> }
	>();
	for (const item of items) {
		const current = headers.get(item.packagePath) ?? {
			classes: new Set<string>(),
			names: new Set<string>(),
			packageName: item.packageName
		};
		for (const classPath of item.classes) current.classes.add(classPath);
		for (const name of item.serializedNames) current.names.add(name);
		headers.set(item.packagePath, current);
	}
	const assets = [...headers.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([packagePath, header]) => ({
			depth: "header" as const,
			fileBytes: 0,
			header: {
				exports: [...header.classes].sort().map((classPath) => ({
					class_name: classPath.slice(classPath.lastIndexOf(".") + 1),
					class_path: classPath,
					object_path: header.packageName
				})),
				matched_names: [...header.names].sort(),
				package: { name: header.packageName },
				path: packagePath,
				schema_version: 8 as const
			}
		}));
	return {
		assets,
		failures: [],
		summary: {
			cacheHits: 0,
			depth: "header",
			diagnostics: [],
			emittedAssets: assets.length,
			failedAssets: 0,
			partialAssets: 0,
			projectRoot,
			roots: [join(projectRoot, "Content")],
			scannedAssets: summary.packageCount,
			schema_version: 8,
			skippedAssets: Math.max(0, summary.packageCount - assets.length)
		}
	};
}

function isEnhancedInputHeader(header: ProjectIndexHeader): boolean {
	return header.classes.some((classPath) => {
		const className = classPath.slice(classPath.lastIndexOf(".") + 1);
		return (
			classPath.startsWith(ENHANCED_INPUT_CLASS_PREFIX) ||
			ENHANCED_INPUT_CLASS_NAME_SUFFIXES.some((suffix) => className.endsWith(suffix))
		);
	});
}

function indexObservation(
	summary: ProjectIndexSummary,
	scan: SavedAssetScan,
	queryPages: number
): IndexObservation {
	return {
		changedPackages: summary.changedPackages,
		emittedHeaders: scan.assets.length,
		generation: summary.generation,
		inputCandidates: scan.assets.filter(
			(entry) =>
				entry.depth === "header" &&
				isEnhancedInputHeader({
					classes: entry.header.exports.flatMap((exported) =>
						exported.class_path === undefined ? [] : [exported.class_path]
					),
					kind: "header",
					packageName: entry.header.package.name,
					packagePath: entry.header.path,
					serializedNames: entry.header.matched_names ?? []
				})
		).length,
		mapCount: summary.mapCount,
		packageCount: summary.packageCount,
		queryPages,
		removedPackages: summary.removedPackages
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

	async stop(cacheRoot: string): Promise<ResourceObservation> {
		clearInterval(this.timer);
		this.stopped = true;
		this.sample();
		if (this.pendingRustSample) {
			await new Promise<void>((resolvePromise) => {
				this.stopResolver = resolvePromise;
			});
		}
		return {
			cacheBytes: cacheBytes(cacheRoot),
			largestProtocolFrameBytes: this.largestProtocolFrameBytes,
			nodePeakRssBytes: this.nodePeakRssBytes,
			protocolBytes: this.outputBytes,
			rustPeakRssBytes: this.rustPeakRssBytes === 0 ? null : this.rustPeakRssBytes
		};
	}
}

function failureKind(cause: unknown): string {
	if (typeof cause === "object" && cause !== null && "kind" in cause) {
		const kind = cause.kind;
		if (typeof kind === "string") return kind;
	}
	return cause instanceof Error ? cause.name : "unknown";
}

interface QueryPages {
	readonly items: readonly ProjectIndexPage["items"][number][];
	readonly pages: number;
	readonly queryMs: number;
}

function queryPages(
	makeRequest: (cursor: ProjectIndexCursor | undefined) => ProjectIndexQueryValue
): Effect.Effect<QueryPages, ProjectIndexError, ProjectIndex> {
	return Effect.gen(function* () {
		let cursor: ProjectIndexCursor | undefined;
		const items: ProjectIndexPage["items"][number][] = [];
		let pages = 0;
		let queryMs = 0;
		while (true) {
			const started = performance.now();
			const page = yield* queryProjectIndex(makeRequest(cursor));
			queryMs += performance.now() - started;
			pages += 1;
			items.push(...page.items);
			if (page.nextCursor === undefined) break;
			cursor = page.nextCursor;
		}
		return { items, pages, queryMs };
	});
}

async function runProjectIndex(
	options: BenchmarkOptions,
	cacheRoot: string,
	projectRoot: string,
	includeInput: boolean,
	protocolObserver: (event: AssetReaderProtocolObservation) => void
): Promise<ProjectIndexSample> {
	let nativeTiming: NativeRefreshTiming | undefined;
	const layer = Layer.merge(
		projectIndexProcessLayer({
			cacheRoot,
			executable: options.reader,
			projectIndexDiagnosticObserver: (event) => {
				if (event.code === "project_index_metrics") {
					nativeTiming = nativeRefreshTiming(event.message);
				}
			},
			protocolObserver,
			timeoutMs: PROJECT_INDEX_TIMEOUT_MS
		}),
		assetReaderLayer({
			catalogTimeoutMs: PROJECT_INDEX_TIMEOUT_MS,
			executable: options.reader,
			protocolObserver,
			timeoutMs: PROJECT_INDEX_TIMEOUT_MS
		})
	);
	return Effect.runPromise(
		Effect.gen(function* () {
			const refreshStarted = performance.now();
			const events = yield* Stream.runCollect(refreshProjectIndex({ projectRoot }));
			const summary = yield* foldProjectIndexRefresh(events);
			const refreshMs = performance.now() - refreshStarted;

			const maps = yield* queryPages((cursor) =>
				ProjectIndexQuery.cases.Maps.make({
					expectedGeneration: summary.generation,
					limit: PROJECT_INDEX_MAX_PAGE_SIZE,
					projectId: summary.projectId,
					...(cursor === undefined ? {} : { cursor })
				})
			);
			const exactClasses = yield* queryPages((cursor) =>
				ProjectIndexQuery.cases.ExactClasses.make({
					expectedGeneration: summary.generation,
					limit: PROJECT_INDEX_MAX_PAGE_SIZE,
					projectId: summary.projectId,
					values: [...SAVED_TABLE_SCAN_CLASSES, STRING_TABLE_CLASS, TEXTURE_CLASS],
					...(cursor === undefined ? {} : { cursor })
				})
			);
			const enhancedPrefixes = yield* queryPages((cursor) =>
				ProjectIndexQuery.cases.ClassPrefixes.make({
					expectedGeneration: summary.generation,
					limit: PROJECT_INDEX_MAX_PAGE_SIZE,
					projectId: summary.projectId,
					values: [ENHANCED_INPUT_CLASS_PREFIX],
					...(cursor === undefined ? {} : { cursor })
				})
			);
			const enhancedSuffixes = yield* queryPages((cursor) =>
				ProjectIndexQuery.cases.ClassNameSuffixes.make({
					expectedGeneration: summary.generation,
					limit: PROJECT_INDEX_MAX_PAGE_SIZE,
					projectId: summary.projectId,
					values: [...ENHANCED_INPUT_CLASS_NAME_SUFFIXES],
					...(cursor === undefined ? {} : { cursor })
				})
			);
			const serializedNames = yield* queryPages((cursor) =>
				ProjectIndexQuery.cases.SerializedNames.make({
					expectedGeneration: summary.generation,
					limit: PROJECT_INDEX_MAX_PAGE_SIZE,
					projectId: summary.projectId,
					values: [TEXT_PROPERTY_NAME],
					...(cursor === undefined ? {} : { cursor })
				})
			);
			const queryMs =
				maps.queryMs +
				exactClasses.queryMs +
				enhancedPrefixes.queryMs +
				enhancedSuffixes.queryMs +
				serializedNames.queryMs;

			const foldingStarted = performance.now();
			const headers = [
				...exactClasses.items,
				...enhancedPrefixes.items,
				...enhancedSuffixes.items,
				...serializedNames.items
			].filter((item): item is ProjectIndexHeader => item.kind === "header");
			const index = headerScanFromProjectIndex(projectRoot, summary, headers);
			const foldingMs = performance.now() - foldingStarted;

			let inputPackages: number | undefined;
			let inputDecodeMs: number | undefined;
			if (includeInput) {
				const inputStarted = performance.now();
				const input = yield* scanEnhancedInputFromProjectIndex(index, { projectRoot });
				inputPackages = input.coverage.inspectedPackages;
				inputDecodeMs = performance.now() - inputStarted;
			}
			if (nativeTiming === undefined) {
				return yield* Effect.fail(
					new Error("The worker did not emit Project Index phase timing diagnostics.")
				);
			}
			return {
				index,
				...(inputPackages === undefined ? {} : { inputPackages }),
				queryPages:
					maps.pages +
					exactClasses.pages +
					enhancedPrefixes.pages +
					enhancedSuffixes.pages +
					serializedNames.pages,
				summary,
				timings: {
					foldingMs,
					...(inputDecodeMs === undefined ? {} : { inputDecodeMs }),
					native: nativeTiming,
					queryMs,
					refreshMs
				}
			};
		}).pipe(Effect.provide(layer))
	);
}

async function observedSample(
	cacheRoot: string,
	operation: (
		observer: (event: AssetReaderProtocolObservation) => void
	) => Promise<ProjectIndexSample>
): Promise<ScenarioSample> {
	const sampler = new ResourceSampler();
	const started = performance.now();
	try {
		const result = await operation(sampler.observe);
		return {
			...(await sampler.stop(cacheRoot)),
			durationMs: roundMilliseconds(performance.now() - started),
			index: indexObservation(result.summary, result.index, result.queryPages),
			...(result.inputPackages === undefined ? {} : { inputPackages: result.inputPackages }),
			timings: {
				...result.timings,
				foldingMs: roundMilliseconds(result.timings.foldingMs),
				...(result.timings.inputDecodeMs === undefined
					? {}
					: { inputDecodeMs: roundMilliseconds(result.timings.inputDecodeMs) }),
				native: {
					committingMs: roundMilliseconds(result.timings.native.committingMs),
					comparingMs: roundMilliseconds(result.timings.native.comparingMs),
					committedEvidenceRows: result.timings.native.committedEvidenceRows,
					durationMs: roundMilliseconds(result.timings.native.durationMs),
					enumeratingMs: roundMilliseconds(result.timings.native.enumeratingMs),
					evidenceWriteMs: roundMilliseconds(result.timings.native.evidenceWriteMs),
					headerReads: result.timings.native.headerReads,
					headerProcessingExcludingEvidenceWritesMs: roundMilliseconds(
						result.timings.native.headerProcessingExcludingEvidenceWritesMs
					),
					removedEvidenceRows: result.timings.native.removedEvidenceRows,
					readingHeadersMs: roundMilliseconds(result.timings.native.readingHeadersMs),
					stagedEvidenceRows: result.timings.native.stagedEvidenceRows
				},
				queryMs: roundMilliseconds(result.timings.queryMs),
				refreshMs: roundMilliseconds(result.timings.refreshMs)
			}
		};
	} catch (cause) {
		return {
			...(await sampler.stop(cacheRoot)),
			durationMs: roundMilliseconds(performance.now() - started),
			failureKind: failureKind(cause)
		};
	}
}

async function runColdSample(
	options: BenchmarkOptions,
	cacheRoot: string
): Promise<ScenarioSample> {
	rmSync(cacheRoot, { force: true, recursive: true });
	return observedSample(cacheRoot, (observer) =>
		runProjectIndex(options, cacheRoot, options.projectRoot, true, observer)
	);
}

async function runIndexSample(
	options: BenchmarkOptions,
	cacheRoot: string,
	projectRoot: string
): Promise<ScenarioSample> {
	return observedSample(cacheRoot, (observer) =>
		runProjectIndex(options, cacheRoot, projectRoot, false, observer)
	);
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
	cacheRoot: string,
	target: DisposableMutationTarget
) {
	const seed = () => runProjectIndex(options, cacheRoot, target.root, false, () => undefined);
	rmSync(cacheRoot, { force: true, recursive: true });
	await seed();
	const changed = await repeated(options.runs, async () => {
		await seed();
		return withChangedPackage(target, () => runIndexSample(options, cacheRoot, target.root));
	});
	const deleted = await repeated(options.runs, async () => {
		await seed();
		return withDeletedPackage(target, () => runIndexSample(options, cacheRoot, target.root));
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
	const primaryCacheRoot = join(tmpdir(), `${cachePrefix}-primary`);
	const mutationCacheRoot = join(tmpdir(), `${cachePrefix}-mutation`);
	try {
		const cold = await repeated(options.runs, () => runColdSample(options, primaryCacheRoot));
		await runIndexSample(options, primaryCacheRoot, options.projectRoot).catch(() => undefined);
		for (let iteration = 0; iteration < options.warmups; iteration += 1) {
			await runIndexSample(options, primaryCacheRoot, options.projectRoot).catch(
				() => undefined
			);
		}
		const warm = await repeated(options.runs, () =>
			runIndexSample(options, primaryCacheRoot, options.projectRoot)
		);
		const mutations =
			mutationTarget === undefined
				? {}
				: await mutationScenarios(options, mutationCacheRoot, mutationTarget);
		const result = {
			schemaVersion: 4,
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
					"The DuckDB Catalog is removed before every sample. The sample includes one refresh, bounded candidate queries, TypeScript folding, and targeted Enhanced Input decode."
				),
				"project_index.warm_noop": scenario(
					warm,
					"The committed DuckDB snapshot is reused. Refresh still enumerates signatures, while unchanged packages should report zero changed packages, zero header reads, and zero evidence writes."
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
		rmSync(primaryCacheRoot, { force: true, recursive: true });
		rmSync(mutationCacheRoot, { force: true, recursive: true });
	}
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && fileURLToPath(import.meta.url) === resolve(entrypoint)) {
	await main();
}
