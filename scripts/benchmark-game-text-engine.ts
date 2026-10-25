import { fork, execFileSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { readFile, writeFile, mkdir, access, lstat, realpath, readdir } from "node:fs/promises";
import { cpus, hostname, platform, release, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Schema } from "effect";
import { withEngineBenchmarkLock } from "./game-text-engine-lock.ts";
import {
	EngineStageResult,
	EngineBenchmarkResult,
	assertEngineAnswers,
	decodeEngineRequestMix,
	engineStatistics,
	engineRequestOverhead,
	EngineTsTiming,
	decodeEngineRustTiming,
	type EngineStageResult as StageResult
} from "./game-text-engine-results.ts";
import {
	childWorkingSet,
	killBenchmarkTree,
	maximumHeapMiB,
	maximumRssBytes,
	maximumStageSeconds,
	assertSafePipelineScale
} from "./game-text-scale-safety.ts";
import { readScaleRecipe } from "./game-text-scale-options.ts";

const { values } = parseArgs({
	options: {
		project: { type: "string" },
		output: { type: "string" },
		cache: { type: "string" },
		records: { type: "string" },
		target: { type: "string" },
		/** Repetitions of the interactive stages: open, reopen, typing, selection, overhead. */
		runs: { type: "string", default: "3" },
		/** Repetitions of the long stages: build and Quality. Their spread is about 2%. */
		"long-runs": { type: "string", default: "1" },
		generated: { type: "boolean", default: false },
		stages: {
			type: "string",
			default: "build,open,cached-reopen,quality,typing,selection"
		},
		instrument: { type: "boolean", default: false },
		"control-executable": { type: "string" },
		"control-api-root": { type: "string" },
		mix: {
			type: "string",
			default: fileURLToPath(new URL("./game-text-engine-mix.json", import.meta.url))
		},
		worker: { type: "boolean", default: false },
		stage: { type: "string" }
	}
});
if (!values.project || !values.output) throw new Error("Provide --project and --output.");
if (!process.versions.node.startsWith("26.")) throw new Error("Use Node 26.");
if (process.env.RAYON_NUM_THREADS !== "16" || process.env.CARGO_BUILD_JOBS !== "8")
	throw new Error("Set RAYON_NUM_THREADS=16 and CARGO_BUILD_JOBS=8.");
const project = resolve(values.project);
const output = resolve(values.output);
if (values.generated && !values.records) values.records = join(output, "records");
const runs = Number(values.runs);
const longRuns = Number(values["long-runs"]);
if (!Number.isSafeInteger(runs) || runs < 1 || !Number.isSafeInteger(longRuns) || longRuns < 1)
	throw new Error("--runs and --long-runs must be positive integers.");
const longStages = new Set([
	"records",
	"build",
	"quality",
	"quality-default",
	"quality-in-process",
	// Each takes many samples itself, or is one long operation whose spread is small.
	"engine-load",
	"loc-check",
	"lines-export"
]);
const mix = decodeEngineRequestMix(JSON.parse(await readFile(values.mix, "utf8")));
if (values.worker) {
	const { runEngineStage } = await import("./game-text-engine-stage.ts");
	try {
		const result = await runEngineStage({
			project,
			output,
			cache: values.cache!,
			mix: values.mix,
			stage: values.stage!,
			records: values.records ? resolve(values.records) : undefined,
			target: values.target
		});
		process.send?.({ kind: "done", result });
	} catch (cause) {
		console.error(cause);
		process.exitCode = 1;
	} finally {
		process.disconnect?.();
	}
} else {
	let stages = values.stages
		.split(",")
		.flatMap((stage) =>
			stage === "typing"
				? mix.hosts.map((host) => `typing:${host.name}:${host.openGroups}`)
				: stage === "selection"
					? [
							"selection:workbench",
							"selection:electroswag",
							"selection:electroswag-worst"
						]
					: [stage]
		);
	const allowedStages = new Set([
		"build",
		"open",
		"cached-reopen",
		"quality",
		"quality-default",
		"quality-in-process",
		"overhead",
		"overhead:small",
		"engine-load",
		"loc-check",
		"lines-export",
		...mix.hosts.map((host) => `typing:${host.name}:${host.openGroups}`),
		"selection:workbench",
		"selection:electroswag",
		"selection:electroswag-worst"
	]);
	for (const stage of stages)
		if (!allowedStages.has(stage)) throw new Error(`Unknown stage ${stage}.`);
	const cacheRoot = resolve(values.cache ?? join(output, "caches"));
	if (
		values["control-executable"] &&
		(values.instrument ||
			!values["control-api-root"] ||
			stages.some((stage) => stage !== "overhead:small"))
	)
		throw new Error(
			"The alternating off control requires --control-api-root, overhead:small only and instrumentation off."
		);
	const destinations = [cacheRoot, output, ...(values.records ? [resolve(values.records)] : [])];
	if (destinations.some((destination) => relativeInside(project, destination)))
		throw new Error(
			"STOP: cache, output and reader records must be outside the input project."
		);
	const canonicalProject = await realpath(project);
	for (const destination of destinations) {
		if (relativeInside(canonicalProject, destination))
			throw new Error(
				"STOP: benchmark directories must be outside the resolved input project."
			);
		for (let ancestor = destination; ; ancestor = dirname(ancestor)) {
			try {
				if ((await lstat(ancestor)).isSymbolicLink())
					throw new Error(
						"STOP: writable benchmark directories cannot use linked ancestors."
					);
			} catch (cause) {
				if (!(cause instanceof Error) || !("code" in cause) || cause.code !== "ENOENT")
					throw cause;
			}
			if (dirname(ancestor) === ancestor) break;
		}
	}
	await mkdir(output, { recursive: true });
	const results: StageResult[] = [];
	const metadata = {
		schemaVersion: 1,
		commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
		node: process.version,
		machine: {
			hostname: hostname(),
			platform: platform(),
			release: release(),
			cpu: cpus()[0]?.model,
			logicalProcessors: cpus().length,
			totalMemoryBytes: totalmem()
		},
		caps: {
			rayonThreads: 16,
			cargoJobs: 8,
			maximumHeapMiB,
			maximumRssBytes,
			maximumStageSeconds
		},
		mix,
		qualityRules: Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(
			await readFile(new URL("./game-text-engine-rules.json", import.meta.url), "utf8")
		),
		results
	};
	const save = async () => {
		const grouped = new Map<string, number[]>();
		for (const result of results)
			for (const sample of result.samples) {
				const key = `${result.stage}:${sample.id}`;
				grouped.set(key, [...(grouped.get(key) ?? []), sample.ms]);
			}
		const report = Schema.decodeUnknownSync(EngineBenchmarkResult)({
			...metadata,
			statistics: Object.fromEntries(
				[...grouped].map(([key, times]) => [key, engineStatistics(times)])
			)
		});
		await writeFile(join(output, "results.json"), JSON.stringify(report, null, "\t") + "\n");
	};
	await withEngineBenchmarkLock(async () => {
		if (values.records) {
			const recipe = await readScaleRecipe(project);
			assertSafePipelineScale(recipe.scale);
			const { validateGameTextScale } = await import("./game-text-scale-validation.ts");
			await writeFile(
				join(output, "validation.json"),
				JSON.stringify(await validateGameTextScale(project), null, "\t")
			);
			try {
				await access(values.records);
			} catch (cause) {
				if (!(cause instanceof Error) || !("code" in cause) || cause.code !== "ENOENT")
					throw cause;
				stages = ["records", ...stages];
			}
		}
		for (let repeat = 0; repeat < Math.max(runs, longRuns); repeat++)
			for (const stage of stages)
				for (const isControl of values["control-executable"] ? [true, false] : [false]) {
					if (stage === "records" && repeat > 0) continue;
					if (repeat >= (longStages.has(stage) ? longRuns : runs)) continue;
					// Interactive repetitions past the last build reuse that build's cache.
					const cache = join(
						cacheRoot,
						`run-${(stage === "build" ? repeat : Math.min(repeat, longRuns - 1)) + 1}`
					);
					if (stage === "build") {
						try {
							await access(cache);
							throw new Error("Build requires an empty, new cache directory.");
						} catch (cause) {
							if (
								!(cause instanceof Error) ||
								!("code" in cause) ||
								cause.code !== "ENOENT"
							)
								throw cause;
						}
					}
					const recordedStage = isControl ? `control-origin:${stage}` : stage;
					const stageOutput = join(
						output,
						`run-${repeat + 1}`,
						recordedStage.replaceAll(":", "-")
					);
					await mkdir(dirname(stageOutput), { recursive: true });
					// Never mix old side files or answers into a new repetition.
					await mkdir(stageOutput);
					const timingOutput = join(stageOutput, "timings");
					if (values.instrument) await mkdir(timingOutput, { recursive: true });
					const log = createWriteStream(join(stageOutput, "worker.log"));
					const child = fork(
						fileURLToPath(import.meta.url),
						[
							"--worker",
							"--project",
							project,
							"--output",
							stageOutput,
							"--cache",
							cache,
							"--stage",
							stage,
							"--mix",
							values.mix,
							...(values.records ? ["--records", resolve(values.records)] : []),
							...(values.target ? ["--target", values.target] : [])
						],
						{
							execArgv: [
								"--import",
								"tsx",
								"--expose-gc",
								"--trace-gc-nvp",
								`--max-old-space-size=${maximumHeapMiB}`
							],
							detached: process.platform !== "win32",
							stdio: ["ignore", "pipe", "pipe", "ipc"],
							env: {
								...process.env,
								UE_SHED_UASSET_EXECUTABLE: isControl
									? values["control-executable"]
									: process.env.UE_SHED_UASSET_EXECUTABLE,
								UE_SHED_ENGINE_API_ROOT: isControl
									? values["control-api-root"]
									: undefined,
								UE_SHED_GAME_TEXT_MEASURE_DIR: values.instrument
									? timingOutput
									: undefined
							}
						}
					);
					let result: StageResult | undefined;
					let peakRss = 0;
					let lastRss = 0;
					let peakHeap = 0;
					let measuring = false;
					let stopped: string | undefined;
					let polling: Promise<void> | undefined;
					let termination: Promise<void> | undefined;
					const stop = (reason: string) => {
						if (stopped) return;
						stopped = reason;
						termination = killBenchmarkTree(child);
					};
					child.stdout?.on("data", (chunk: Buffer) => {
						log.write(chunk);
						if (measuring)
							for (const match of chunk
								.toString()
								.matchAll(
									/(?:total_size_before|start_object_size)["\s]*[:=](\d+)/gu
								))
								peakHeap = Math.max(peakHeap, Number(match[1]));
					});
					child.stderr?.pipe(log, { end: false });
					child.on("message", (raw) => {
						const message = Schema.decodeUnknownSync(
							Schema.Struct({
								kind: Schema.String,
								result: Schema.optionalKey(EngineStageResult)
							})
						)(raw);
						if (message.kind === "done") result = message.result;
						if (message.kind === "start") {
							measuring = true;
							// A short request can finish between OS samples; retain its prepared reader.
							peakRss = lastRss;
							peakHeap = 0;
						}
						if (message.kind === "pause") measuring = false;
						if (message.kind === "resume") measuring = true;
					});
					const timer = setTimeout(
						() => stop("STOP: stage exceeded the hard time cap."),
						maximumStageSeconds * 1000
					);
					const sampler = setInterval(() => {
						if (polling || !child.pid) return;
						polling = childWorkingSet(child.pid, true)
							.then((rss) => {
								lastRss = rss;
								if (measuring) peakRss = Math.max(peakRss, rss);
								if (rss > maximumRssBytes)
									stop("STOP: process tree exceeded the hard RSS cap.");
							})
							.catch((cause) => {
								if (child.exitCode === null)
									stop(`OS sampler failed: ${String(cause)}`);
							})
							.finally(() => {
								polling = undefined;
							});
					}, 1000);
					process.stdout.write(`Run ${repeat + 1}/${runs}: ${recordedStage}\n`);
					try {
						const code = await new Promise<number | null>((done, reject) => {
							child.once("error", reject);
							child.once("close", done);
						});
						await termination;
						await polling;
						if (stopped || code !== 0 || !result) {
							await writeFile(
								join(stageOutput, "failure.json"),
								JSON.stringify({ stopped, code, peakRss, peakHeap })
							);
							throw new Error(
								stopped ?? `Stage ${stage} failed; inspect ${stageOutput}.`
							);
						}
						if (values.instrument && stage === "overhead") {
							const ts: (typeof EngineTsTiming.Type)[] = [];
							const rust: ReturnType<typeof decodeEngineRustTiming>[] = [];
							for (const file of await readdir(timingOutput)) {
								const lines = (await readFile(join(timingOutput, file), "utf8"))
									.trim()
									.split("\n")
									.filter(Boolean);
								for (const line of lines) {
									if (file.startsWith("ts-"))
										ts.push(
											Schema.decodeUnknownSync(EngineTsTiming)(
												JSON.parse(line)
											)
										);
									if (file.startsWith("rust-"))
										rust.push(decodeEngineRustTiming(JSON.parse(line)));
								}
							}
							if (!ts.length || !rust.length)
								throw new Error(
									"Missing benchmark spans: rebuild TypeScript packages and the reader with benchmark-timings."
								);
							result = {
								...result,
								samples: result.samples.map((sample) => ({
									...sample,
									metrics: {
										...sample.metrics,
										...engineRequestOverhead(sample.id, sample.ms, ts, rust)
									}
								}))
							};
						}
						results.push({
							...result,
							stage: recordedStage,
							peakHeapBytes: Math.max(peakHeap, result.peakHeapBytes),
							peakRssBytes: Math.max(peakRss, result.peakRssBytes)
						});
						await save();
						// A failed answer is a broken path, not a timing: stop instead of repeating it.
						const failed = result.samples.find((sample) => sample.metrics.failed === 1);
						if (failed)
							throw new Error(
								`Stage ${recordedStage} answered ${failed.id} with a failure; inspect ${stageOutput}.`
							);
						assertEngineAnswers(results);
						if (values["control-executable"])
							assertEngineAnswers(
								results.map((result) => ({
									...result,
									stage: result.stage.replace(/^control-origin:/u, "")
								}))
							);
					} finally {
						clearTimeout(timer);
						clearInterval(sampler);
						log.end();
						await killBenchmarkTree(child);
					}
				}
	});
	await save();
}

function relativeInside(root: string, child: string) {
	const prefix = resolve(root).toLowerCase() + "/";
	return (
		resolve(child)
			.replaceAll("\\", "/")
			.toLowerCase()
			.startsWith(prefix.replaceAll("\\", "/")) ||
		resolve(root).toLowerCase() === resolve(child).toLowerCase()
	);
}
