/**
 * `diskChanges` over a generated ~707k-package project of tiny real files (it reads metadata only).
 * In order: `--mode generate`, `index` (warm index), then `measure` in fresh readers (`--case
 * touched` first saves and adds 1,000 packages) or `host` (recursive `readdir`, then `stat`).
 * Args: `--root <dir> [--executable <uasset>] [--case unchanged|touched] [--runs 3]`; prints JSON.
 */
import { spawn } from "node:child_process";
import { mkdir, readdir, realpath, stat, utimes, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { Context, Effect, Layer, Stream } from "effect";
import { LocalizationEvidenceNodeLive } from "../packages/localization/dist/index.js";
import {
	NativeGameTextIndexClient,
	nativeGameTextIndexClientLayer
} from "../packages/unreal-assets/dist/index.js";
import {
	GameTextIndexRefresh,
	GameTextIndexSource
} from "../packages/game-text/src/index-contract.ts";
import { gameTextIndexRefreshLayer } from "../packages/game-text/src/index-refresh.ts";
import { nativeIndexQueryLayer } from "../packages/game-text/src/index-query-native.ts";
import { nativeIndexBuilderLayer } from "../packages/game-text/src/native-index-builder.ts";
import { nativeIndexConfiguration } from "../packages/game-text/src/native-index-configuration.ts";
import type { PackageTextInventoryEntry } from "../packages/game-text/src/package-text-layer.ts";

const { values } = parseArgs({
	options: {
		mode: { type: "string" },
		root: { type: "string" },
		executable: { type: "string" },
		case: { type: "string", default: "unchanged" },
		runs: { type: "string", default: "3" },
		packages: { type: "string", default: "707000" }
	}
});
if (!values.root) throw new Error("Provide --root, the directory that holds the project.");
const root = resolve(values.root);
const projectRoot = join(root, "project");
const cacheRoot = join(root, "cache");
const count = Number(values.packages);
if (!Number.isSafeInteger(count) || count < 1000) throw new Error("--packages must be >= 1000.");
const runs = Number(values.runs);

const SIDECAR_EVERY = 8;
const MAP_EVERY = 50;
const TOUCHED = 1000;
const ADDED = 1000;
const NAMED = 100;
const packagePath = (id: number) =>
	`Content/Area${String(id % 97).padStart(2, "0")}/Group${String((id >> 5) % 89).padStart(2, "0")}/P${id}.${id % MAP_EVERY === 0 ? "umap" : "uasset"}`;
const sidecarPath = (path: string) => path.replace(/\.[^.]+$/u, ".uexp");
const addedPath = (n: number) => `Content/Added/Group${n % 10}/N${n}.uasset`;

const generate = async () => {
	const started = performance.now();
	const directories = new Set<string>();
	for (let id = 0; id < count; id++) directories.add(dirname(join(projectRoot, packagePath(id))));
	for (const directory of directories) await mkdir(directory, { recursive: true });
	let written = 0;
	const files = function* () {
		for (let id = 0; id < count; id++) {
			const path = packagePath(id);
			yield { path, bytes: 1 + (id % 4) };
			if (id % SIDECAR_EVERY === 0) yield { path: sidecarPath(path), bytes: 2 };
		}
	};
	const queue = files();
	const worker = async () => {
		for (let next = queue.next(); !next.done; next = queue.next()) {
			await writeFile(join(projectRoot, next.value.path), Buffer.alloc(next.value.bytes, 1));
			if (++written % 50_000 === 0)
				console.error(
					`${written} files, ${Math.round((performance.now() - started) / 1000)} s`
				);
		}
	};
	await Promise.all(Array.from({ length: 16 }, worker));
	return {
		mode: "generate",
		packages: count,
		files: written,
		directories: directories.size,
		seconds: Math.round((performance.now() - started) / 100) / 10
	};
};

/** An `f64` as `serde_json` writes it: shortest round trip, with `.0` on whole numbers. */
const rustNumber = (value: number) => (Number.isInteger(value) ? `${value}.0` : String(value));
/**
 * A package's bundle signature as the Catalog writes it (`bundle_signature`): the package's and
 * each sidecar's size and modification time, in milliseconds from nanoseconds.
 */
const signature = async (path: string) => {
	const parts = await Promise.all(
		[
			path,
			...["uexp", "ubulk", "uptnl"].map((extension) =>
				path.replace(/\.[^.]+$/u, `.${extension}`)
			)
		].map((file) =>
			stat(join(projectRoot, file), { bigint: true }).then(
				(stats) =>
					`{"size":${rustNumber(Number(stats.size))},"modifiedMs":${rustNumber(Number(stats.mtimeNs) / 1e6)}}`,
				() => "null"
			)
		)
	);
	return `[${parts.join(",")}]`;
};

const readerConfiguration = (executable: string) => ({
	executable,
	timeoutMs: 3_600_000,
	catalogTimeoutMs: 3_600_000
});
const executable = () => {
	if (!values.executable) throw new Error("Provide --executable, the paired uasset reader.");
	return resolve(values.executable);
};

/** Publishes the saved-text view of the project, every package with its stated signature. */
const index = async () => {
	const started = performance.now();
	const paths: string[] = [];
	for (let id = 0; id < count; id++) paths.push(packagePath(id));
	const inventory: PackageTextInventoryEntry[] = [];
	for (let start = 0; start < paths.length; start += 256) {
		const batch = paths.slice(start, start + 256);
		const signatures = await Promise.all(batch.map(signature));
		batch.forEach((path, row) =>
			inventory.push({
				path,
				signature: signatures[row]!,
				headerData: {
					packageFlags: 0,
					gatherableTextDataCount: 0,
					gatherableTextDataOffset: 0,
					hasTextProperty: false
				}
			})
		);
	}
	inventory.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
	const statedMs = performance.now() - started;
	const source = Layer.succeed(GameTextIndexSource, {
		inventory: () => Effect.succeed(inventory),
		read: () => Stream.empty
	});
	const configuration = readerConfiguration(executable());
	const layer = gameTextIndexRefreshLayer(cacheRoot).pipe(
		Layer.provide(source),
		Layer.provide(nativeIndexBuilderLayer(configuration)),
		Layer.provide(nativeIndexQueryLayer(configuration)),
		Layer.provide(LocalizationEvidenceNodeLive)
	);
	const refreshed = await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const model = yield* (yield* GameTextIndexRefresh).refresh({ projectRoot });
				return {
					generation: model.generation,
					changedShards: model.packages.changedShards
				};
			})
		).pipe(Effect.provide(layer))
	);
	return {
		mode: "index",
		inventory: inventory.length,
		statedMs: Math.round(statedMs),
		totalMs: Math.round(performance.now() - started),
		...refreshed
	};
};

/** Saves 1,000 packages again (a minute later) and adds 1,000. */
const touch = async () => {
	const stride = Math.floor(count / TOUCHED);
	const later = new Date(Date.now() + 60_000);
	for (let n = 0; n < TOUCHED; n++)
		await utimes(join(projectRoot, packagePath(n * stride + 1)), later, later);
	for (let n = 0; n < ADDED; n++) {
		const file = join(projectRoot, addedPath(n));
		await mkdir(dirname(file), { recursive: true });
		await writeFile(file, Buffer.alloc(3, 1));
	}
};

/** Runs a command and returns what it printed. */
const output = (command: string, args: readonly string[]) =>
	new Promise<string>((done, fail) => {
		const child = spawn(command, args, { windowsHide: true });
		let stdout = "";
		child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
		child.on("error", fail);
		child.on("close", () => done(stdout));
	});

/** The peak working set of this process's one uasset child, in MiB. */
const readerPeakMiB = async () => {
	const listed = await output("powershell.exe", [
		"-NoProfile",
		"-NonInteractive",
		"-Command",
		`Get-CimInstance Win32_Process -Filter "ParentProcessId=${process.pid}" | Where-Object { $_.Name -like 'uasset*' } | ForEach-Object { (Get-Process -Id $_.ProcessId).PeakWorkingSet64 }`
	]);
	const peaks = listed.trim().split(/\r?\n/u).map(Number).filter(Boolean);
	if (peaks.length !== 1) throw new Error(`Expected one reader process, found ${peaks.length}.`);
	return Math.round((peaks[0]! / 2 ** 20) * 10) / 10;
};

/** One check, every page, in a fresh reader process. */
const check = async (paths?: readonly string[]) => {
	const projectKey = await realpath(projectRoot);
	const configuration = nativeIndexConfiguration({
		cacheRoot,
		projectKey,
		targetKey: "SavedText",
		projectView: { kind: "source" }
	});
	return Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const services = yield* Layer.build(
					nativeGameTextIndexClientLayer(readerConfiguration(executable()))
				);
				const client = Context.get(services, NativeGameTextIndexClient);
				yield* client.execute({ action: "capabilities" });
				const started = performance.now();
				let engineSeconds = 0;
				let observeSeconds = 0;
				let pages = 0;
				let items = 0;
				let after: string | undefined;
				let counts;
				do {
					const result = yield* client.execute({
						action: "disk_changes",
						configuration,
						request: {
							projectRoot: projectKey,
							...(paths === undefined ? undefined : { paths: [...paths] }),
							...(after === undefined ? undefined : { after }),
							limit: 1000
						}
					});
					engineSeconds += result.stageSeconds["disk_changes"] ?? 0;
					observeSeconds += result.stageSeconds["disk_changes.observe"] ?? 0;
					pages++;
					const answer = result.diskChanges;
					if (answer?.status !== "ready") throw new Error("The view is not indexed.");
					counts = answer.counts;
					items += answer.items.length;
					after = answer.nextCursor;
				} while (after !== undefined);
				const wallMs = performance.now() - started;
				return {
					wallMs: Math.round(wallMs),
					engineSeconds: Math.round(engineSeconds * 1000) / 1000,
					// The walk, or stating the named paths; the rest reads and compares the index.
					observeSeconds: Math.round(observeSeconds * 1000) / 1000,
					readerPeakMiB: yield* Effect.promise(readerPeakMiB),
					pages,
					items,
					counts
				};
			})
		)
	);
};

const median = (numbers: readonly number[]) =>
	[...numbers].sort((a, b) => a - b)[Math.floor(numbers.length / 2)]!;
const summarize = <A extends { wallMs: number; engineSeconds: number; readerPeakMiB: number }>(
	samples: readonly A[]
) => ({
	median: {
		wallMs: median(samples.map((sample) => sample.wallMs)),
		engineSeconds: median(samples.map((sample) => sample.engineSeconds)),
		readerPeakMiB: median(samples.map((sample) => sample.readerPeakMiB))
	},
	samples
});

const measure = async () => {
	if (values.case === "touched") await touch();
	const walks = [];
	for (let run = 0; run < runs; run++) walks.push(await check());
	// Named paths: half saved again, half as indexed.
	const stride = Math.floor(count / TOUCHED);
	const named = Array.from({ length: NAMED }, (_, n) =>
		packagePath(n % 2 === 0 ? (n / 2) * stride + 1 : n * 7919 + 2)
	);
	const pathChecks = [];
	for (let run = 0; run < runs; run++) pathChecks.push(await check(named));
	return {
		mode: "measure",
		case: values.case,
		node: process.version,
		walk: summarize(walks),
		paths: summarize(pathChecks)
	};
};

/** A host's own check: list the tree with file types, then state every package file in 64s. */
const host = async () => {
	const samples = [];
	for (let run = 0; run < runs; run++) {
		const started = performance.now();
		const files: string[] = [];
		const walk = async (directory: string): Promise<void> => {
			for (const entry of await readdir(directory, { withFileTypes: true })) {
				const path = join(directory, entry.name);
				if (entry.isDirectory()) await walk(path);
				else if (entry.isFile() && /\.(uasset|umap|uexp|ubulk|uptnl)$/iu.test(entry.name))
					files.push(path);
			}
		};
		await walk(join(projectRoot, "Content"));
		const listedMs = performance.now() - started;
		const stamps = new Map<string, readonly [number, number]>();
		for (let start = 0; start < files.length; start += 64)
			await Promise.all(
				files.slice(start, start + 64).map(async (file) => {
					const stats = await stat(file);
					stamps.set(file, [stats.size, stats.mtimeMs]);
				})
			);
		samples.push({
			wallMs: Math.round(performance.now() - started),
			listedMs: Math.round(listedMs),
			files: stamps.size
		});
	}
	return {
		mode: "host",
		node: process.version,
		medianWallMs: median(samples.map((sample) => sample.wallMs)),
		peakRssMiB: Math.round((process.resourceUsage().maxRSS / 1024) * 10) / 10,
		samples
	};
};

const run =
	values.mode === "generate"
		? generate
		: values.mode === "index"
			? index
			: values.mode === "measure"
				? measure
				: values.mode === "host"
					? host
					: undefined;
if (!run) throw new Error("--mode must be generate, index, measure or host.");
console.log(JSON.stringify(await run()));
