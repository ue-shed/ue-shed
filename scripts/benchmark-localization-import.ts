import { fork } from "node:child_process";
import { mkdir, writeFile, open } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { performance } from "node:perf_hooks";
import { Effect, Schema } from "effect";
import {
	LocalizationEvidence,
	LocalizationEvidenceNodeLive
} from "../packages/localization/dist/index.js";
import {
	importLocalizationFile,
	importLocalizationTarget
} from "../packages/game-text/src/localization-import.ts";
import { repositoryPath, readScaleRecipe } from "./game-text-scale-options.ts";
import {
	childWorkingSet,
	killBenchmarkTree,
	maximumHeapMiB,
	maximumRssBytes,
	maximumStageSeconds,
	benchmarkRunSeconds,
	benchmarkRunExpired,
	boundedNumber
} from "./game-text-scale-safety.ts";
import { captureBenchmarkByte, restoreBenchmarkByte } from "./localization-benchmark-byte.ts";

// Includes Node startup and module loading, discovery and every file in the cold import.
const runStarted = 0;

const { values } = parseArgs({
	options: {
		project: { type: "string" },
		cache: { type: "string" },
		output: { type: "string" },
		mode: { type: "string", default: "files" },
		worker: { type: "boolean" },
		select: { type: "string" },
		profile: { type: "boolean" },
		"po-change-byte": { type: "string" },
		report: { type: "string" },
		domain: { type: "string" },
		records: { type: "string" },
		"run-timeout-seconds": { type: "string" }
	}
});
if (!values.project || !values.cache || !values.output)
	throw new Error("Provide --project, --cache and --output.");
const project = repositoryPath(values.project),
	cache = repositoryPath(values.cache),
	output = repositoryPath(values.output);
const mode = Schema.decodeUnknownSync(
	Schema.Literals(["files", "target", "size", "shared", "package", "join"])
)(values.mode);
const changedPoByte = boundedNumber(values["po-change-byte"] ?? "110", "--po-change-byte", 122);
if (!Number.isInteger(changedPoByte) || changedPoByte < 97)
	throw new Error("--po-change-byte must be a lowercase ASCII letter's byte (97–122).");
const Memory = Schema.Struct({
	heapUsed: Schema.Number,
	arrayBuffers: Schema.Number,
	rss: Schema.Number
});
const Message = Schema.Struct({
	kind: Schema.Literals(["stage", "sample", "result", "done", "failed"]),
	stage: Schema.optionalKey(Schema.String),
	result: Schema.optionalKey(Schema.Json),
	memory: Schema.optionalKey(Memory),
	error: Schema.optionalKey(Schema.String)
});
const memory = () => {
	const { heapUsed, arrayBuffers, rss } = process.memoryUsage();
	return { heapUsed, arrayBuffers, rss };
};

if (values.worker) {
	if (!process.send) throw new Error("Localization worker requires its supervised parent.");
	const results: unknown[] = [];
	let peak = memory();
	let stage = "startup";
	const sample = () => {
		const current = memory();
		for (const key of ["heapUsed", "arrayBuffers", "rss"] as const)
			peak[key] = Math.max(peak[key], current[key]);
		process.send?.({ kind: "sample", stage, memory: peak });
	};
	const timer = setInterval(sample, 25);
	async function measure<A>(name: string, run: () => Promise<A>, summary: (value: A) => object) {
		globalThis.gc?.();
		stage = name;
		peak = memory();
		process.send?.({ kind: "stage", stage });
		const started = performance.now();
		const value = await run();
		sample();
		const result = {
			stage,
			seconds: (performance.now() - started) / 1000,
			peak,
			...summary(value)
		};
		results.push(result);
		process.send?.({ kind: "result", result });
	}
	try {
		const target = await Effect.runPromise(
			Effect.gen(function* () {
				const evidence = yield* LocalizationEvidence;
				const discovered = yield* evidence.discover({ projectRoot: project });
				const target = discovered.targets.find((value) => value.name === "Generated");
				if (!target) throw new Error("Generated target missing.");
				return target;
			}).pipe(Effect.provide(LocalizationEvidenceNodeLive))
		);
		let coldKeys = new Map<string, string>();
		const files = [
			{ path: target.outputPaths.manifest, format: "manifest" as const },
			...target.cultures.flatMap((culture) => [
				{ path: target.outputPaths.archives[culture], format: "archive" as const },
				{ path: target.outputPaths.portableObjects[culture], format: "po" as const }
			])
		];
		if (mode === "shared") {
			const { measureSharedIndex } = await import("./game-text-shared-measure.ts");
			await measureSharedIndex(
				project,
				cache,
				measure,
				values.select ?? "all",
				changedPoByte
			);
		}
		if (mode === "size") {
			await measure(
				"size",
				async () => {
					const { measureLocalizationSize } =
						await import("./localization-import-size.ts");
					return measureLocalizationSize(repositoryPath(values.report!), values.domain);
				},
				(value) => ({ measurements: value })
			);
		}
		const passes: readonly ("cold" | "touched" | "unchanged" | "changed")[] =
			mode === "size" || mode === "shared" || mode === "package" || mode === "join"
				? []
				: ["cold", "touched", "unchanged", "changed"];
		if (mode === "package") {
			const { measurePackageTextLayer } = await import("./package-text-measure.ts");
			if (!values.records) throw new Error("Package measurements require --records");
			await measurePackageTextLayer(
				project,
				cache,
				repositoryPath(values.records),
				measure,
				values.select ?? "all"
			);
		}
		if (mode === "join") {
			const { measureColumnarJoin } = await import("./columnar-join-measure.ts");
			await measureColumnarJoin(
				project,
				cache,
				values.records ? repositoryPath(values.records) : "",
				measure,
				values.select ?? "all",
				changedPoByte
			);
		}
		for (const pass of passes) {
			if (pass === "changed" && mode === "files") continue;
			if (pass === "touched") {
				process.send?.({ kind: "stage", stage: "rewrite" });
				for (const file of files.filter(
					(file) => !values.select || file.path?.endsWith(values.select)
				)) {
					const handle = await open(resolve(project, file.path!), "r+");
					try {
						const size = (await handle.stat()).size;
						const buffer = new Uint8Array(1024 * 1024);
						for (let offset = 0; offset < size; ) {
							const { bytesRead } = await handle.read(
								buffer,
								0,
								Math.min(buffer.length, size - offset),
								offset
							);
							if (!bytesRead) throw new Error("Short rewrite read");
							for (let written = 0; written < bytesRead; )
								written += (
									await handle.write(
										buffer,
										written,
										bytesRead - written,
										offset + written
									)
								).bytesWritten;
							offset += bytesRead;
						}
						await handle.sync();
					} finally {
						await handle.close();
					}
				}
			}
			let restore: (() => Promise<void>) | undefined;
			if (pass === "changed") {
				const file = files.find((file) => file.format === "po")!;
				const handle = await open(resolve(project, file.path!), "r+");
				const buffer = new Uint8Array(4096);
				await handle.read(buffer, 0, buffer.length, 0);
				const offset = Buffer.from(buffer).indexOf("mirava");
				if (offset < 0) throw new Error("Change word absent");
				const original = buffer[offset]!;
				await handle.write(Uint8Array.of(original === 109 ? 110 : 109), 0, 1, offset);
				await handle.sync();
				restore = async () => {
					try {
						await handle.write(Uint8Array.of(original), 0, 1, offset);
						await handle.sync();
					} finally {
						await handle.close();
					}
				};
			}
			try {
				if (mode === "files") {
					for (const file of files.filter(
						(file) => !values.select || file.path?.endsWith(values.select)
					)) {
						if (!file.path) throw new Error("Missing generated file path.");
						await measure(
							`${pass}:${file.path}`,
							() =>
								Effect.runPromise(
									importLocalizationFile({
										projectRoot: project,
										cacheRoot: cache,
										relativePath: file.path!,
										format: file.format,
										poFormat: target.poFormat,
										collapseMode: target.collapseMode
									})
								),
							(value) => {
								if (value.parsed !== (pass === "cold"))
									throw new Error(`Unexpected cache result: ${pass}`);
								return {
									inputBytes: value.inputBytes,
									readBytes: value.readBytes,
									statHit: value.statHit,
									snapshotBytes: value.snapshotBytes,
									parsed: value.parsed,
									key: value.key
								};
							}
						);
					}
				} else
					await measure(
						`${pass}:target`,
						() =>
							Effect.runPromise(
								importLocalizationTarget({
									projectRoot: project,
									cacheRoot: cache,
									targetName: target.name
								}).pipe(Effect.provide(LocalizationEvidenceNodeLive))
							),
						(value) => {
							const expected =
								pass === "cold" ? files.length : pass === "changed" ? 1 : 0;
							if (value.files.filter((file) => file.parsed).length !== expected)
								throw new Error(`Expected ${expected} parsed files in ${pass}`);
							if (pass === "cold")
								coldKeys = new Map(
									value.files.map((file) => [file.relativePath, file.key])
								);
							else if (
								value.files.filter(
									(file) => file.key !== coldKeys.get(file.relativePath)
								).length !== (pass === "changed" ? 1 : 0)
							)
								throw new Error(`Unexpected changed keys in ${pass}`);
							if (value.diagnostics.length)
								throw new Error(JSON.stringify(value.diagnostics));
							return {
								inputBytes: value.files.reduce((n, file) => n + file.inputBytes, 0),
								snapshotBytes: value.files.reduce(
									(n, file) => n + file.snapshotBytes,
									0
								),
								parsedFiles: value.files.filter((file) => file.parsed).length,
								readBytes: value.files.reduce((n, file) => n + file.readBytes, 0),
								statHits: value.files.filter((file) => file.statHit).length,
								files: value.files
							};
						}
					);
			} finally {
				await restore?.();
			}
		}
		process.send?.({ kind: "done", result: { node: process.version, mode, results } });
	} catch (cause) {
		process.send?.({ kind: "failed", error: String(cause) });
		process.exitCode = 1;
	} finally {
		clearInterval(timer);
		process.disconnect?.();
	}
} else {
	const hardRunSeconds = benchmarkRunSeconds((await readScaleRecipe(project)).scale);
	const runSeconds =
		values["run-timeout-seconds"] === undefined
			? hardRunSeconds
			: boundedNumber(
					values["run-timeout-seconds"],
					"run-timeout-seconds",
					hardRunSeconds ?? maximumStageSeconds
				);
	const runFailure = `Whole run exceeded ${runSeconds} seconds (10× hard maximum: 15 minutes, including cold target import).`;
	// A forced kill bypasses the worker's finally block. Parent owns the authored-byte guard.
	const changedByte =
		mode === "target" ||
		mode === "package" ||
		(mode === "join" && ["all", "refresh"].includes(values.select ?? "all")) ||
		(mode === "shared" && ["all", "cold", "refresh"].includes(values.select ?? "all"))
			? await captureBenchmarkByte(
					resolve(project, "Content/Localization/Generated/en/Generated.po"),
					"mirava"
				)
			: undefined;
	await mkdir(resolve(output, ".."), { recursive: true });
	const environment: NodeJS.ProcessEnv = { ...process.env, TSX_DISABLE_CACHE: "1" };
	delete environment.NODE_OPTIONS;
	const child = fork(
		fileURLToPath(import.meta.url),
		[
			"--worker",
			"--project",
			project,
			"--cache",
			cache,
			"--output",
			output,
			"--mode",
			mode,
			"--po-change-byte",
			String(changedPoByte),
			...(values.select ? ["--select", values.select] : []),
			...(values.report ? ["--report", values.report] : []),
			...(values.domain ? ["--domain", values.domain] : []),
			...(values.records ? ["--records", values.records] : [])
		],
		{
			execArgv: [
				"--import",
				"tsx",
				`--max-old-space-size=${maximumHeapMiB}`,
				"--expose-gc",
				"--trace-gc-nvp",
				...(values.profile ? ["--cpu-prof", `--cpu-prof-dir=${resolve(output, "..")}`] : [])
			],
			env: environment,
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe", "ipc"]
		}
	);
	let stage = "startup",
		stageStarted = performance.now(),
		progressAt = stageStarted + 50000,
		polling = false;
	let outcome: typeof Message.Type | undefined;
	let termination = Promise.resolve();
	let stderr = "",
		trace = "";
	const stages: Record<string, { osPeakRss: number; tracePeakHeap: number }> = {};
	const results: Schema.Json[] = [];
	const stop = (error: string) => {
		if (outcome?.kind === "failed") return;
		outcome = { kind: "failed", error };
		termination = killBenchmarkTree(child);
	};
	child.stderr?.on("data", (chunk) => {
		stderr = (stderr + String(chunk)).slice(-4096);
	});
	child.stdout?.on("data", (chunk) => {
		trace += String(chunk);
		const lines = trace.split("\n");
		trace = lines.pop() ?? "";
		const current = (stages[stage] ??= { osPeakRss: 0, tracePeakHeap: 0 });
		for (const line of lines)
			current.tracePeakHeap = Math.max(
				current.tracePeakHeap,
				Number(line.match(/(?:total_size_before|start_object_size)"?[:=](\d+)/u)?.[1] ?? 0)
			);
	});
	const save = () =>
		writeFile(
			output,
			JSON.stringify(
				{
					outcome,
					results,
					stages,
					limits: {
						heapMiB: maximumHeapMiB,
						rssBytes: maximumRssBytes,
						stageSeconds: maximumStageSeconds,
						runSeconds: runSeconds ?? null
					},
					wallSeconds: (performance.now() - runStarted) / 1000
				},
				null,
				"\t"
			) + "\n"
		);
	child.on("message", (input) => {
		if (benchmarkRunExpired(runStarted, performance.now(), runSeconds)) {
			stop(runFailure);
			return;
		}
		if (outcome?.kind === "failed") return;
		const decoded = Schema.decodeUnknownResult(Message)(input);
		if (decoded._tag === "Failure") {
			stop("Invalid worker message.");
			return;
		}
		const message = decoded.success;
		if (message.kind === "stage") {
			stage = message.stage ?? "unknown";
			stageStarted = performance.now();
			progressAt = stageStarted + 50000;
			console.log(`Stage ${stage}`);
		} else if (message.kind === "result" && message.result !== undefined) {
			results.push(message.result);
			console.log(JSON.stringify(message.result));
		} else if (message.kind === "done" || message.kind === "failed") outcome = message;
	});
	const deadline =
		runSeconds === undefined
			? undefined
			: setTimeout(
					() => stop(runFailure),
					Math.max(0, runSeconds * 1000 - (performance.now() - runStarted))
				);
	const watchdog = setInterval(() => {
		if (performance.now() >= progressAt && !outcome) {
			const current = stages[stage];
			console.log(
				`Progress ${stage}: ${((performance.now() - stageStarted) / 1000).toFixed(0)} s; ` +
					`peak OS RSS ${((current?.osPeakRss ?? 0) / 1024 ** 2).toFixed(1)} MiB; ` +
					`pre-GC heap ${((current?.tracePeakHeap ?? 0) / 1024 ** 2).toFixed(1)} MiB`
			);
			progressAt = performance.now() + 50000;
		}
		if (performance.now() - stageStarted > maximumStageSeconds * 1000)
			stop("Stage exceeded 20 minutes.");
		if (polling || !child.pid || outcome) return;
		polling = true;
		const sampledStage = stage;
		void childWorkingSet(child.pid)
			.then((rss) => {
				const current = (stages[sampledStage] ??= { osPeakRss: 0, tracePeakHeap: 0 });
				current.osPeakRss = Math.max(current.osPeakRss, rss);
				if (rss + process.memoryUsage().rss > maximumRssBytes)
					stop("Total parent and child RSS exceeded 20 GB.");
			})
			.catch((cause) => {
				if (child.exitCode === null && child.signalCode === null) stop(String(cause));
			})
			.finally(() => {
				polling = false;
			});
	}, 1000);
	await new Promise<void>((done) => {
		child.once("error", (cause) => stop(String(cause)));
		child.once("close", () => done());
	});
	clearInterval(watchdog);
	clearTimeout(deadline);
	await termination;
	try {
		await restoreBenchmarkByte(changedByte);
	} catch (cause) {
		outcome = { kind: "failed", error: `Authored-byte restoration failed: ${String(cause)}` };
	}
	if (benchmarkRunExpired(runStarted, performance.now(), runSeconds))
		outcome = { kind: "failed", error: runFailure };
	if (!outcome) outcome = { kind: "failed", error: stderr };
	await save();
	console.log(`Finished ${mode}: ${outcome.kind}`);
	if (outcome.kind !== "done") process.exitCode = 1;
}
