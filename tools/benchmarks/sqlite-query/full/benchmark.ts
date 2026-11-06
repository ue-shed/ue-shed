import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { childWorkingSet, killBenchmarkTree } from "../../../../scripts/game-text-scale-safety.ts";
import { withCorpusUnrealLock } from "../../../../scripts/game-text-corpus-lock.ts";
import { Schema } from "effect";
import { BenchmarkRun } from "./metrics.ts";

const [rootPath, outputPath, repetitionsText = "5"] = process.argv.slice(2);
if (!rootPath || !outputPath) throw new Error("benchmark.ts BUNDLE NEW_OUTPUT [REPETITIONS]");
const root = resolve(rootPath),
	output = resolve(outputPath),
	repetitions = Number(repetitionsText);
if (!Number.isInteger(repetitions) || repetitions < 3 || repetitions > 10)
	throw new Error("Use 3-10 repetitions");
await mkdir(output);
const worker = fileURLToPath(new URL("./benchmark-worker.ts", import.meta.url));
const results: (BenchmarkRun & {
	processTree: { peakRss: number; polls: number; intervalMs: number };
})[] = [];
await withCorpusUnrealLock(async () => {
	for (let round = 0; round < 3; round++)
		for (const lane of round % 2 ? ["bun", "rust"] : ["rust", "bun"]) {
			const path = resolve(output, `${round}-${lane}.json`);
			const child = spawn(
				lane === "bun" ? "bun" : process.execPath,
				[
					...(lane === "rust" ? ["--max-old-space-size=8192", "--import", "tsx"] : []),
					worker,
					root,
					lane,
					path,
					String(round),
					String(repetitions)
				],
				{
					windowsHide: true,
					detached: process.platform !== "win32",
					stdio: ["ignore", "pipe", "pipe"],
					env: { ...process.env, RAYON_NUM_THREADS: "16" }
				}
			);
			let peakRss = 0,
				polls = 0,
				diagnostics = "",
				pending: Promise<void> | undefined,
				failure: Error | undefined;
			child.stdout.on("data", (bytes: Buffer) => {
				const line = bytes.toString();
				diagnostics += line;
				process.stdout.write(line);
			});
			child.stderr.on("data", (bytes: Buffer) => {
				diagnostics += bytes.toString();
			});
			const timer = setInterval(() => {
				if (pending || !child.pid || child.exitCode !== null) return;
				pending = childWorkingSet(child.pid, true)
					.then(async (rss) => {
						peakRss = Math.max(peakRss, rss);
						polls++;
						if (rss > 8 * 1024 ** 3) {
							failure = new Error("Process tree exceeded 8 GiB");
							await killBenchmarkTree(child);
						}
					})
					.catch(async (cause: Error) => {
						if (child.exitCode === null) {
							failure = cause;
							await killBenchmarkTree(child);
						}
					})
					.finally(() => {
						pending = undefined;
					});
			}, 1500);
			const deadline = setTimeout(() => {
				failure = new Error("Process exceeded 20 minutes");
				void killBenchmarkTree(child);
			}, 1200000);
			try {
				await new Promise<void>((accept, reject) => {
					child.once("error", reject);
					child.once("close", (code) =>
						code === 0
							? accept()
							: reject(new Error(`${lane}/${round} exited ${code}: ${diagnostics}`))
					);
				});
				if (failure) throw failure;
			} finally {
				clearInterval(timer);
				clearTimeout(deadline);
				await pending;
			}
			const result = Schema.decodeUnknownSync(Schema.fromJsonString(BenchmarkRun))(
				await readFile(path, "utf8")
			);
			results.push({ ...result, processTree: { peakRss, polls, intervalMs: 1500 } });
			await writeFile(
				resolve(output, `${round}-${lane}.resources.json`),
				JSON.stringify({ peakRss, polls, diagnostics })
			);
		}
});
const names = [
	...new Set(results.flatMap((run) => run.samples.map((sample: { name: string }) => sample.name)))
];
const median = (numbers: number[]) =>
	[...numbers].sort((a, b) => a - b)[Math.floor(numbers.length / 2)]!;
const summary = names.flatMap((name) =>
	["rust", "bun"].map((lane) => {
		const samples = results
			.filter((run) => run.lane === lane)
			.flatMap((run) => run.samples)
			.filter((sample) => sample.name === name);
		const times = samples.map((sample) => Number(sample.ms));
		return {
			name,
			lane,
			n: times.length,
			medianMs: median(times),
			minMs: Math.min(...times),
			maxMs: Math.max(...times),
			medianCallbackGapMs: median(samples.map((sample) => sample.callbackGap.maximumDelayMs))
		};
	})
);
await writeFile(
	resolve(output, "results.json"),
	JSON.stringify({
		methodology: {
			independentProcessesPerLane: 3,
			repetitions,
			warmupsPerCasePerProcess: 1,
			maxProcessTreeBytes: 8 * 1024 ** 3,
			deadlineMs: 1200000,
			excludedFromTimer: "correctness hashing"
		},
		summary,
		results
	})
);
console.log(
	JSON.stringify({
		finished: true,
		observations: results.reduce((n, run) => n + run.samples.length, 0)
	})
);
