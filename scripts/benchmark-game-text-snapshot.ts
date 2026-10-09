import { fork } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { Effect, Schema } from "effect";
import {
	SnapshotStore,
	snapshotStoreNodeLayer,
	snapshotCompressionLevel
} from "../packages/game-text/src/snapshot-store.ts";
import {
	openSnapshotFile,
	writeSnapshotFile,
	snapshotColumnsSource,
	snapshotFileSource,
	type SnapshotLoadedDomain
} from "../packages/game-text/src/snapshot-file.ts";
import { readScaleEvidence, readScaleCorpus, joinScaleTarget } from "./game-text-scale-pipeline.ts";
import { joinedTargetSnapshot } from "./game-text-snapshot-data.ts";
import { repositoryPath, readScaleRecipe } from "./game-text-scale-options.ts";
import {
	childWorkingSet,
	killBenchmarkTree,
	maximumHeapMiB,
	maximumRssBytes,
	maximumStageSeconds
} from "./game-text-scale-safety.ts";

const { values } = parseArgs({
	options: {
		task: { type: "string" },
		reference: { type: "string" },
		"block-kib": { type: "string", default: "256" },
		profile: { type: "boolean", default: false },
		worker: { type: "boolean" },
		project: { type: "string", default: "test-results/game-text-scale/project-1x" },
		file: { type: "string", default: "test-results/game-text-scale/snapshot-v2-1x.raw" },
		level: { type: "string", default: "1" },
		output: { type: "string", default: "test-results/game-text-scale/snapshot-phase2.json" }
	}
});
const project = repositoryPath(values.project);
const file = repositoryPath(values.file);
const output = repositoryPath(values.output);
const reference = repositoryPath(
	values.reference ??
		(values.task === "synthetic10"
			? "test-results/game-text-scale/snapshot-v3-final-1x-256.snapshot"
			: "test-results/game-text-scale/snapshot-v2-1x.raw")
);
const blockBytes = Schema.decodeUnknownSync(Schema.Literals(["16", "64", "256"]))(
	values["block-kib"]
);
const levelName = Schema.decodeUnknownSync(Schema.Literals(["1", "3", "6", "9", "19", "chosen"]))(
	values.level
);
const level = levelName === "chosen" ? snapshotCompressionLevel : Number(levelName);
const memory = () => {
	const { heapUsed, arrayBuffers, rss } = process.memoryUsage();
	return { heapUsed, arrayBuffers, rss };
};
const WorkerResult = Schema.Record(Schema.String, Schema.Json);
type WorkerResult = typeof WorkerResult.Type;
const WorkerMessage = Schema.Struct({
	kind: Schema.Literals(["stage", "done", "failed", "stopped"]),
	stage: Schema.optionalKey(Schema.String),
	task: Schema.optionalKey(Schema.String),
	node: Schema.optionalKey(Schema.String),
	error: Schema.optionalKey(Schema.String),
	result: Schema.optionalKey(WorkerResult),
	peak: Schema.optionalKey(
		Schema.Struct({ heapUsed: Schema.Number, arrayBuffers: Schema.Number, rss: Schema.Number })
	),
	nativePeakRss: Schema.optionalKey(Schema.Number),
	seconds: Schema.optionalKey(Schema.Number)
});
type WorkerMessage = typeof WorkerMessage.Type;
function group(name: string) {
	if (/^c[0-9]+\.(b[0-9]|starts|translation|po)/u.test(name)) return "cultures";
	if (name.startsWith("identity.")) return "identity";
	if (name.startsWith("source.")) return "source";
	if (name.startsWith("hot.b")) return "source-identity";
	if (
		name.startsWith("paths.") ||
		[
			"line.place",
			"occurrence.package",
			"occurrence.object",
			"occurrence.property",
			"occurrence.row"
		].includes(name)
	)
		return "paths";
	if (name.startsWith("comments.") || name.startsWith("review.") || name.startsWith("change."))
		return "comments";
	return "hot-columns";
}
function sizes(directory: Awaited<ReturnType<typeof openSnapshotFile>>["directory"]) {
	const groups: Record<string, { raw: number; stored: number; sections: number }> = {};
	for (const entry of directory.entries.values()) {
		const value = (groups[group(entry.name)] ??= { raw: 0, stored: 0, sections: 0 });
		value.raw += entry.rawLength;
		value.stored += entry.storedLength;
		value.sections++;
	}
	return {
		groups,
		fileBytes: directory.fileLength,
		directoryBytes: 48 + directory.entries.size * 96
	};
}
if (values.task === undefined)
	throw new Error(
		"Provide --task reblock1, synthetic10, probe, publish, open, measure or build1"
	);
if (values.worker) {
	const started = performance.now();
	let stage = "startup";
	let heapUsed = 0,
		arrayBuffers = 0,
		rss = 0;
	const sample = () => {
		const value = memory();
		heapUsed = Math.max(heapUsed, value.heapUsed);
		arrayBuffers = Math.max(arrayBuffers, value.arrayBuffers);
		rss = Math.max(rss, value.rss);
	};
	const timer = setInterval(sample, 25);
	const mark = (name: string) => {
		sample();
		stage = name;
		process.send?.({ kind: "stage", stage });
	};
	try {
		let result: WorkerResult;
		if (values.task === "reblock1") {
			mark("saved-section-replay");
			const { reblockSnapshot } = await import("./game-text-snapshot-reblock.ts");
			const directory = await reblockSnapshot(reference, file, Number(blockBytes) * 1024);
			result = { ...sizes(directory) };
		} else if (values.task === "build1") {
			if ((await readScaleRecipe(project)).scale !== 1)
				throw new Error("Today's join is permitted only at 1×");
			// Exclusive claim prevents a second pipeline run even if a build failed. Reuse the raw file.
			await writeFile(`${file}.build-once`, "Phase 2 one-time join\n", { flag: "wx" });
			mark("evidence");
			const evidence = await readScaleEvidence(project);
			globalThis.gc?.();
			mark("corpus");
			const corpus = await readScaleCorpus(project);
			globalThis.gc?.();
			mark("join");
			const joined = await joinScaleTarget(project, corpus, evidence);
			globalThis.gc?.();
			mark("encode");
			const begin = performance.now();
			const { columns, dimensions } = joinedTargetSnapshot(project, corpus, joined.join);
			const directory = await writeSnapshotFile(
				file,
				snapshotColumnsSource(columns),
				0,
				sample
			);
			const encodeMs = performance.now() - begin;
			await writeFile(
				`${file}.dimensions.json`,
				JSON.stringify(dimensions, null, "\t") + "\n"
			);
			result = { dimensions, ...sizes(directory), encodeMs };
		} else if (values.task === "synthetic10") {
			mark("synthetic10");
			const { syntheticScaleSnapshot } = await import("./game-text-snapshot-synthetic.ts");
			result = await syntheticScaleSnapshot(
				project,
				file,
				mark,
				reference,
				Number(blockBytes) * 1024
			);
		} else if (values.task === "measure") {
			mark("section-publish");
			const raw = await openSnapshotFile(file);
			const destination = `${file}.zstd-${values.level}`;
			try {
				const begin = performance.now();
				const directory = await writeSnapshotFile(
					destination,
					snapshotFileSource(raw),
					level,
					sample
				);
				const publishMs = performance.now() - begin;
				sample();
				const encoded = await openSnapshotFile(destination);
				const decodeStart = performance.now();
				try {
					await encoded.verify();
				} finally {
					await encoded.close();
				}
				result = {
					level: values.level,
					...sizes(directory),
					publishMs,
					decodeMs: performance.now() - decodeStart
				};
			} finally {
				await raw.close();
			}
		} else if (values.task === "publish") {
			mark("store-publish");
			const raw = await openSnapshotFile(file);
			const begin = performance.now();
			try {
				const manifest = await Effect.runPromise(
					Effect.scoped(
						Effect.gen(function* () {
							const store = yield* SnapshotStore;
							const writer = yield* store.writer();
							return yield* writer.publish(snapshotFileSource(raw), {
								recipe: "phase2",
								layout: "joined-target-probe-v3"
							});
						})
					).pipe(
						Effect.provide(
							snapshotStoreNodeLayer({
								cacheRoot: resolve(file, "..", "snapshot-cache-v3-chosen"),
								projectKey: file,
								targetKey: "Generated"
							})
						)
					)
				);
				result = { publishMs: performance.now() - begin, manifest };
			} finally {
				await raw.close();
			}
		} else if (values.task === "open" || values.task === "probe") {
			globalThis.gc?.();
			const baseline = memory();
			const checkpoints: WorkerResult[] = [];
			const retained: SnapshotLoadedDomain[] = [];
			const numeric = new Map<string, Uint8Array | Uint32Array>();
			const checkpoint = async (name: string, begin: number, extra: WorkerResult = {}) => {
				const ms = performance.now() - begin;
				sample();
				await new Promise<void>((done) => setImmediate(done));
				globalThis.gc?.();
				await new Promise<void>((done) => setImmediate(done));
				globalThis.gc?.();
				checkpoints.push({ name, ms, cumulative: memory(), ...extra });
			};
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const store = yield* SnapshotStore;
						mark("directory-open");
						let begin = performance.now();
						const reader =
							values.task === "probe"
								? yield* Effect.acquireRelease(
										Effect.promise(() => openSnapshotFile(file)),
										(fileReader) => Effect.promise(() => fileReader.close())
									).pipe(
										Effect.map((fileReader) => ({
											directory: fileReader.directory,
											section: (name: string) =>
												Effect.promise(() => fileReader.load(name)),
											strings: (domain: string, ids: readonly number[]) =>
												Effect.promise(() =>
													fileReader.strings(domain, ids)
												),
											domain: (domain: string) =>
												Effect.promise(() => fileReader.domain(domain))
										}))
									)
								: yield* store.open();
						yield* Effect.promise(() => checkpoint("directory", begin));
						mark("hot-open");
						begin = performance.now();
						for (const entry of reader.directory.entries.values()) {
							const otherCultureFlags =
								/^c([1-9][0-9]*)\.(facts|reasons|reduced)$/u.test(entry.name);
							if (group(entry.name) === "hot-columns" && !otherCultureFlags)
								numeric.set(entry.name, yield* reader.section(entry.name));
						}
						yield* Effect.promise(() => checkpoint("hot", begin));
						for (const [name, domain] of [
							["source", "source"],
							["culture", "c0"],
							["paths", "paths"]
						] as const) {
							mark(name);
							begin = performance.now();
							const loaded = yield* reader.domain(domain);
							retained.push(loaded);
							yield* Effect.promise(() =>
								checkpoint(name, begin, {
									timings: loaded.timings,
									rawBytes: loaded.bytes.length
								})
							);
							mark(`${name}-scan`);
							begin = performance.now();
							const needle =
								name === "paths"
									? "/"
									: loaded.string(1).includes("invented")
										? "SOURCE"
										: "TALUMA";
							const matches = loaded.scanSubstring(needle);
							yield* Effect.promise(() =>
								checkpoint(`${name}-scan`, begin, { matches, needle })
							);
						}
						mark("page-columns");
						begin = performance.now();
						for (const entry of reader.directory.entries.values())
							if (
								/^c0\.(translation|po)/u.test(entry.name) ||
								(group(entry.name) === "paths" && entry.kind !== "strings")
							)
								numeric.set(entry.name, yield* reader.section(entry.name));
						yield* Effect.promise(() => checkpoint("page-columns", begin));
						mark("page");
						begin = performance.now();
						const source = numeric.get("line.source")!;
						const identity = numeric.get("line.id")!;
						const keys = numeric.get("line.key")!;
						const namespace = numeric.get("line.namespace")!;
						const sourcePage = yield* reader.strings(
							"source",
							Array.from(source.slice(0, 50))
						);
						const page = yield* reader.strings("identity", [
							...identity.slice(0, 50),
							...keys.slice(0, 50),
							...namespace.slice(0, 50)
						]);
						const translations = numeric.get("c0.translation")!;
						const translatedPage = yield* reader.strings(
							"c0",
							Array.from(translations.subarray(0, 50))
						);
						const places = numeric.get("line.place")!;
						const pathPage = yield* reader.strings(
							"paths",
							Array.from(places.subarray(0, 50))
						);
						yield* Effect.promise(() => checkpoint("page", begin));
						result = {
							baseline,
							...sizes(reader.directory),
							checkpoints,
							pageStrings:
								sourcePage.length +
								page.length +
								translatedPage.length +
								pathPage.length
						};
					})
				).pipe(
					Effect.provide(
						snapshotStoreNodeLayer({
							cacheRoot: resolve(file, "..", "snapshot-cache-v3-chosen"),
							projectKey: file,
							targetKey: "Generated"
						})
					)
				)
			);
			// Explicit reachability prevents GC from understating cumulative cold-table buffers.
			result = {
				...result!,
				retainedColdBytes: retained.reduce((sum, value) => sum + value.bytes.byteLength, 0)
			};
		} else throw new Error("Unknown task");
		sample();
		process.send?.({
			kind: "done",
			task: values.task,
			node: process.version,
			result,
			peak: { heapUsed, arrayBuffers, rss },
			nativePeakRss: process.resourceUsage().maxRSS * 1024,
			seconds: (performance.now() - started) / 1000
		});
	} catch (cause) {
		process.send?.({
			kind: "failed",
			stage,
			error: String(cause),
			peak: { heapUsed, arrayBuffers, rss }
		});
		process.exitCode = 1;
	} finally {
		clearInterval(timer);
		process.disconnect?.();
	}
} else {
	await mkdir(resolve(output, ".."), { recursive: true });
	const environment = { ...process.env };
	delete environment.NODE_OPTIONS;
	environment.TSX_DISABLE_CACHE = "1";
	const child = fork(
		fileURLToPath(import.meta.url),
		[
			"--worker",
			"--task",
			values.task,
			"--project",
			project,
			"--file",
			file,
			"--level",
			values.level,
			"--reference",
			reference,
			"--block-kib",
			blockBytes
		],
		{
			execArgv: [
				"--import",
				"tsx",
				"--max-old-space-size=" + maximumHeapMiB,
				"--expose-gc",
				"--trace-gc-nvp",
				...(values.profile
					? ["--cpu-prof", "--cpu-prof-dir=test-results/game-text-scale"]
					: [])
			],
			env: environment,
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe", "ipc"]
		}
	);
	let stageStarted = performance.now(),
		polling = false,
		peakRss = 0,
		traceHeap = 0;
	let currentStage = "startup";
	const stageRss: Record<string, number> = {};
	let stderr = "",
		trace = "",
		outcome: WorkerMessage | undefined;
	let termination = Promise.resolve();
	const stop = (error: string) => {
		if (outcome !== undefined) return;
		outcome = { kind: "stopped", error };
		termination = killBenchmarkTree(child);
	};
	child.stderr?.on("data", (chunk) => {
		stderr = (stderr + String(chunk)).slice(-4096);
	});
	child.stdout?.on("data", (chunk) => {
		trace += String(chunk);
		const lines = trace.split("\n");
		trace = lines.pop() ?? "";
		for (const line of lines)
			traceHeap = Math.max(
				traceHeap,
				Number(line.match(/(?:total_size_before|start_object_size)"?[:=](\d+)/u)?.[1] ?? 0)
			);
	});
	child.on("message", (message) => {
		let decoded: WorkerMessage;
		try {
			decoded = Schema.decodeUnknownSync(WorkerMessage)(message);
		} catch (cause) {
			stop(`Invalid worker message: ${String(cause)}`);
			return;
		}
		if (decoded.kind === "stage") {
			stageStarted = performance.now();
			currentStage = decoded.stage ?? "unknown";
			console.log("Stage: " + decoded.stage);
		} else outcome = decoded;
	});
	const watchdog = setInterval(() => {
		if (performance.now() - stageStarted > maximumStageSeconds * 1000)
			stop("Stage exceeded 20 minutes");
		if (polling || child.pid === undefined || outcome !== undefined) return;
		polling = true;
		const polledStage = currentStage;
		void childWorkingSet(child.pid)
			.then((rss) => {
				peakRss = Math.max(peakRss, rss);
				stageRss[polledStage] = Math.max(stageRss[polledStage] ?? 0, rss);
				if (rss > maximumRssBytes) stop("RSS exceeded 20 GB");
			})
			.catch((cause) => {
				if (child.exitCode === null && child.signalCode === null)
					stop("OS RSS watchdog failed: " + String(cause));
			})
			.finally(() => {
				polling = false;
			});
	}, 1000);
	await new Promise<void>((done) => {
		child.once("error", (error) => {
			stop(String(error));
		});
		child.once("close", () => done());
	});
	clearInterval(watchdog);
	await termination;
	const result = {
		outcome: outcome ?? { kind: "failed", error: stderr },
		osPeakRss: peakRss,
		tracePeakHeap: traceHeap,
		stageRss,
		limits: {
			heapMiB: maximumHeapMiB,
			rssBytes: maximumRssBytes,
			stageSeconds: maximumStageSeconds
		}
	};
	await writeFile(output, JSON.stringify(result, null, "\t") + "\n");
	console.log(JSON.stringify(result));
	if (outcome === undefined || !("kind" in outcome) || outcome.kind !== "done")
		process.exitCode = 1;
}
