import { fork } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { getHeapStatistics } from "node:v8";
import { Schema } from "effect";
import {
	readScaleEvidence,
	readScaleCorpus,
	joinScaleTarget,
	scaleStatus
} from "./game-text-scale-pipeline.ts";
import { repositoryPath, readScaleRecipe } from "./game-text-scale-options.ts";
import {
	boundedNumber,
	childWorkingSet,
	killBenchmarkTree,
	maximumHeapMiB,
	maximumRssBytes,
	maximumStageSeconds
} from "./game-text-scale-safety.ts";

const Memory = Schema.Struct({
	heapUsed: Schema.Number,
	rss: Schema.Number,
	arrayBuffers: Schema.Number
});
const Stage = Schema.Literals(["evidence", "corpus", "join", "status"]);
const Message = Schema.Struct({
	kind: Schema.Literals(["start", "sample", "complete", "failure", "done"]),
	stage: Stage,
	memory: Memory,
	seconds: Schema.Number,
	retained: Schema.optionalKey(Memory),
	error: Schema.optionalKey(Schema.String),
	counts: Schema.optionalKey(Schema.Record(Schema.String, Schema.Number))
});
type Message = typeof Message.Type;
type Memory = typeof Memory.Type;
const { values } = parseArgs({
	options: {
		project: { type: "string" },
		heaps: { type: "string", default: "default" },
		output: { type: "string" },
		worker: { type: "boolean", default: false },
		"max-rss-gib": { type: "string", default: String(maximumRssBytes / 2 ** 30) },
		"stage-timeout-seconds": { type: "string", default: String(maximumStageSeconds) }
	}
});
if (values.project === undefined)
	throw new Error("Provide --project with a generated project directory.");
const project = repositoryPath(values.project);
if ((await readScaleRecipe(project)).scale >= 10)
	throw new Error(
		"10× pipeline not run: unsafe in-memory workload. Use validate:game-text-scale."
	);
const memory = (): Memory => {
	const { heapUsed, rss, arrayBuffers } = process.memoryUsage();
	return { heapUsed, rss, arrayBuffers };
};
const peak = (a: Memory, b: Memory): Memory => ({
	heapUsed: Math.max(a.heapUsed, b.heapUsed),
	rss: Math.max(a.rss, b.rss),
	arrayBuffers: Math.max(a.arrayBuffers, b.arrayBuffers)
});

if (values.worker) {
	let stage: typeof Stage.Type = "evidence";
	let started = performance.now();
	let maximum = memory();
	let lastSent = started;
	const send = (kind: Message["kind"], extras: Partial<Message> = {}) => {
		maximum = peak(maximum, memory());
		process.send?.({
			kind,
			stage,
			memory: maximum,
			seconds: (performance.now() - started) / 1000,
			...extras
		} satisfies Message);
	};
	const timer = setInterval(() => {
		maximum = peak(maximum, memory());
		if (performance.now() - lastSent >= 250) {
			send("sample");
			lastSent = performance.now();
		}
	}, 25);
	async function measure<A>(name: typeof Stage.Type, run: () => Promise<A> | A): Promise<A> {
		stage = name;
		started = performance.now();
		maximum = memory();
		send("start", { counts: { heapLimitBytes: getHeapStatistics().heap_size_limit } });
		const value = await run();
		send("sample"); // Synchronous stages block timer sampling; capture before collecting garbage.
		globalThis.gc?.();
		send("complete", { retained: memory() });
		return value;
	}
	try {
		const evidence = await measure("evidence", () => readScaleEvidence(project));
		const corpus = await measure("corpus", () => readScaleCorpus(project));
		const joined = await measure("join", () => joinScaleTarget(project, corpus, evidence));
		const status = await measure("status", () => scaleStatus(corpus, evidence, joined.join));
		const german = status.report.counts.find((culture) => culture.culture === "de");
		send("done", {
			counts: {
				heapLimitBytes: getHeapStatistics().heap_size_limit,
				lines: joined.join.lines.length,
				units: corpus.units.length,
				occurrences: corpus.coverage.textOccurrences,
				packages: corpus.coverage.discoveredPackages,
				gaps: corpus.coverage.unsupportedTextProperties,
				keyChanges: joined.keyChanges.pairs.length,
				pageLines: status.page.units.length,
				...Object.fromEntries(
					Object.entries(german?.states ?? {}).map(([state, counts]) => [
						`de_${state}`,
						counts.lines
					])
				)
			}
		});
	} catch (cause) {
		send("sample");
		globalThis.gc?.();
		send("failure", {
			error: cause instanceof Error ? (cause.stack ?? cause.message) : String(cause),
			retained: memory()
		});
		process.exitCode = 1;
	} finally {
		clearInterval(timer);
		process.disconnect?.();
	}
} else {
	const maxRss =
		boundedNumber(values["max-rss-gib"], "RSS GiB", maximumRssBytes / 2 ** 30) * 2 ** 30;
	const timeout =
		boundedNumber(values["stage-timeout-seconds"], "stage timeout", maximumStageSeconds) * 1000;
	const output = repositoryPath(
		values.output ?? `test-results/game-text-scale/benchmark-${Date.now()}.json`
	);
	await mkdir(resolve(output, ".."), { recursive: true });
	const heaps = values.heaps.split(",").map((heap) => {
		if (heap === "default") return heap;
		const limit = boundedNumber(heap, "heap MiB", maximumHeapMiB);
		if (!Number.isSafeInteger(limit)) throw new Error("Heap MiB must be an integer.");
		return limit;
	});
	const results: unknown[] = [];
	const save = () =>
		writeFile(
			output,
			JSON.stringify(
				{
					schemaVersion: 1,
					node: process.version,
					sampleIntervalMs: 25,
					rssPollIntervalMs: 1000,
					maxRssBytes: maxRss,
					stageTimeoutSeconds: timeout / 1000,
					sampling:
						"Heap: 25 ms timer/checkpoints plus V8 pre-GC trace peaks (including synchronous stages). RSS: timer and independent parent OS poll. Array buffers: timer/checkpoint lower bound during synchronous stages. Final GC per stage. Peaks include retained inputs from prior stages.",
					results
				},
				null,
				"\t"
			) + "\n"
		);
	for (const heap of heaps) {
		const started = performance.now();
		const stages: Record<
			string,
			{ status: string; seconds: number; peak: Memory; retained?: Memory }
		> = {};
		const result = {
			heapMiB: heap,
			status: "running",
			failureStage: "startup",
			error: "",
			seconds: 0,
			peak: { heapUsed: 0, rss: 0, arrayBuffers: 0 },
			stages,
			counts: {}
		};
		results.push(result);
		const environment = { ...process.env };
		delete environment.NODE_OPTIONS;
		const child = fork(fileURLToPath(import.meta.url), ["--worker", "--project", project], {
			execArgv: [
				"--expose-gc",
				"--trace-gc-nvp",
				...(heap === "default" ? [] : [`--max-old-space-size=${heap}`])
			],
			env: environment,
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe", "ipc"]
		});
		let stage = "startup";
		let stageStarted = performance.now();
		let stderr = "";
		let trace = "";
		let polling = false;
		let termination = Promise.resolve();
		let saveQueue = Promise.resolve();
		const queueSave = () => {
			saveQueue = saveQueue.then(save);
		};
		const stop = (error: string) => {
			if (result.status !== "running") return;
			result.status = "stopped";
			result.error = error;
			result.failureStage = stage;
			termination = killBenchmarkTree(child).catch((cause) => {
				result.error += `; process-tree termination failed: ${String(cause)}`;
			});
		};
		child.stderr?.on("data", (data: Buffer) => {
			stderr = (stderr + data.toString()).slice(-16_384);
		});
		child.stdout?.on("data", (data: Buffer) => {
			trace += data.toString();
			const lines = trace.split("\n");
			trace = lines.pop() ?? "";
			for (const line of lines) {
				const heapUsed = Number(
					line.match(/(?:total_size_before|start_object_size)=(\d+)/u)?.[1] ?? 0
				);
				result.peak.heapUsed = Math.max(result.peak.heapUsed, heapUsed);
				const current = stages[stage];
				if (current !== undefined)
					current.peak = {
						...current.peak,
						heapUsed: Math.max(current.peak.heapUsed, heapUsed)
					};
			}
		});
		child.on("message", (raw) => {
			if (result.status === "stopped") return;
			const message = Schema.decodeUnknownSync(Message)(raw);
			if (message.counts !== undefined)
				result.counts = { ...result.counts, ...message.counts };
			stage = message.stage;
			if (message.kind === "start") {
				stageStarted = performance.now();
				stages[stage] = { status: "running", seconds: 0, peak: message.memory };
			}
			const current = stages[stage];
			if (current !== undefined) {
				if (message.retained !== undefined) current.retained = message.retained;
				current.seconds = message.seconds;
				current.peak = peak(current.peak, message.memory);
				if (message.kind === "complete") {
					current.status = "passed";
				}
			}
			result.peak = peak(result.peak, message.memory);
			if (message.memory.rss > maxRss) {
				stop("RSS limit exceeded");
				queueSave();
				return;
			}
			if (message.kind === "done") {
				result.status = "passed";
				result.failureStage = "";
				result.counts = message.counts ?? {};
			}
			if (message.kind === "failure") {
				result.status = "failed";
				result.failureStage = stage;
				result.error = message.error ?? "Unknown worker failure";
			}
			if (message.kind !== "sample") queueSave();
		});
		// The parent watchdog still runs while V8 is in GC or a synchronous join/parser.
		const watchdog = setInterval(() => {
			if (performance.now() - stageStarted > timeout) stop("Stage time limit exceeded");
			if (polling || child.pid === undefined || result.status !== "running") return;
			polling = true;
			const polledStage = stage;
			void childWorkingSet(child.pid)
				.then((rss) => {
					result.peak = { ...result.peak, rss: Math.max(result.peak.rss, rss) };
					const current = stages[polledStage];
					if (current !== undefined)
						current.peak = { ...current.peak, rss: Math.max(current.peak.rss, rss) };
					if (rss > maxRss) stop("RSS limit exceeded");
				})
				.catch((cause) => {
					if (child.exitCode === null && child.signalCode === null)
						stop(`OS RSS watchdog failed: ${String(cause)}`);
				})
				.finally(() => {
					polling = false;
				});
		}, 1000);
		await new Promise<void>((done) => {
			child.once("error", (error) => {
				result.error = String(error);
			});
			child.once("close", (code, signal) => {
				clearInterval(watchdog);
				result.seconds = (performance.now() - started) / 1000;
				if (result.status === "running") {
					result.status = "failed";
					result.failureStage = stage;
					result.error = `Worker exited (${code ?? signal}): ${result.error}\n${stderr}`;
				}
				const current = stages[stage];
				if (current !== undefined && current.status === "running") {
					current.status = result.status;
					current.seconds = (performance.now() - stageStarted) / 1000;
				}
				done();
			});
		});
		await termination;
		await saveQueue;
		await save();
		console.log(JSON.stringify(result));
	}
	console.log(`Results: ${output}`);
	if (
		results.some(
			(result) =>
				Schema.decodeUnknownSync(Schema.Struct({ status: Schema.String }))(result)
					.status !== "passed"
		)
	)
		process.exitCode = 1;
}
