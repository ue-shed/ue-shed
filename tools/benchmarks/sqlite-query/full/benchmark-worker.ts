import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { channel } from "node:diagnostics_channel";
import { trackBenchmarkEventLoop } from "../../../../scripts/benchmark-event-loop.ts";
import { withNative } from "./native.ts";
import { nativeAnswer } from "./conformance.ts";
import { openDatabase } from "./database.ts";
import { SqliteQuery } from "./query.ts";
import { evaluate, digest } from "./evaluate.ts";
import { json, type Json, type RetainedInput } from "./model.ts";
import type { Case } from "./workload.ts";

const [rootPath, lane, outputPath, roundText = "0", repetitionsText = "5"] = process.argv.slice(2);
if (!rootPath || !outputPath || !["rust", "bun"].includes(lane!))
	throw new Error("benchmark-worker.ts ROOT rust|bun OUTPUT ROUND REPETITIONS");
const root = resolve(rootPath),
	round = Number(roundText),
	repetitions = Number(repetitionsText);
const expected: { workload: Case[]; hashes: string[] } = JSON.parse(
	await readFile(resolve(root, "expected.json"), "utf8")
);
const input: RetainedInput = JSON.parse(await readFile(resolve(root, "input.json"), "utf8"));
const cases = expected.workload.filter((entry) => entry.benchmark);
const hashes = new Map(expected.workload.map((entry, i) => [entry.name, expected.hashes[i]!]));
const began = performance.now();
const events: Json[] = [];
const metrics = channel("ue-shed.game-text-benchmark");
const observer: Parameters<typeof metrics.subscribe>[0] = (value) => {
	events.push(json(value));
};
metrics.subscribe(observer);
async function measure(execute: (entry: Case) => Promise<Json>, version: Json) {
	const setupMs = performance.now() - began;
	const warmups = [],
		samples = [];
	for (const entry of cases) {
		console.log(JSON.stringify({ lane, round, phase: "warmup", starting: entry.name }));
		const at = performance.now(),
			value = await execute(entry),
			ms = performance.now() - at;
		const sha256 = digest(value);
		if (sha256 !== hashes.get(entry.name))
			throw new Error(`Warmup parity failed: ${entry.name}`);
		warmups.push({ name: entry.name, ms, sha256 });
	}
	for (let repetition = 0; repetition < repetitions; repetition++) {
		const offset = (round + repetition) % cases.length;
		for (const entry of [...cases.slice(offset), ...cases.slice(0, offset)]) {
			console.log(JSON.stringify({ lane, round, repetition, starting: entry.name }));
			events.length = 0;
			const loop = trackBenchmarkEventLoop();
			const at = performance.now();
			let value: Json;
			try {
				value = await execute(entry);
			} finally {
				loop.stop();
			}
			const ms = performance.now() - at;
			const phases = [...events];
			const sha256 = digest(value);
			if (sha256 !== hashes.get(entry.name))
				throw new Error(`Timed parity failed: ${entry.name}`);
			samples.push({
				name: entry.name,
				repetition,
				ms,
				sha256,
				phases,
				callbackGap: loop.stop()
			});
			console.log(JSON.stringify({ lane, round, repetition, complete: entry.name, ms }));
		}
		console.log(
			JSON.stringify({ lane, round, repetition: repetition + 1, complete: cases.length })
		);
	}
	await writeFile(
		outputPath!,
		JSON.stringify({
			lane,
			round,
			setupMs,
			version,
			runtime: process.versions,
			warmups,
			samples,
			memory: process.memoryUsage()
		})
	);
}
try {
	if (lane === "rust")
		await withNative(input, resolve("target/release/uasset.exe"), (query) =>
			measure((entry) => nativeAnswer(query, entry), {
				reader: "shipping Rust with public TypeScript host"
			})
		);
	else {
		const db = await openDatabase(resolve(root, "complete.sqlite"));
		try {
			const query = new SqliteQuery(db);
			await measure(
				async (entry) => evaluate(query, entry),
				json(db.prepare("SELECT sqlite_version() AS sqlite").all())
			);
		} finally {
			db.close();
		}
	}
} finally {
	metrics.unsubscribe(observer);
}
