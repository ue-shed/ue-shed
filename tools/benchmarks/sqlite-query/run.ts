/** Alternating fresh-process measurements, parity gate, process-tree memory and a bounded runtime. */
import { spawn, execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile, stat, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { hostname, cpus, totalmem } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { childWorkingSet, killBenchmarkTree } from "../../../scripts/game-text-scale-safety.ts";
import { withCorpusUnrealLock } from "../../../scripts/game-text-corpus-lock.ts";
import { canonicalLocalizationJson } from "../../../packages/game-text/src/localization-fingerprint.ts";
import type { GameTextContract } from "../../../packages/protocol/dist/index.js";

const { values } = parseArgs({
	options: {
		input: { type: "string" },
		output: { type: "string" },
		runs: { type: "string", default: "3" },
		repetitions: { type: "string", default: "7" },
		reader: { type: "string", default: "target/release/uasset.exe" },
		bridge: { type: "string", default: "target/release/sqlite-query-spike.exe" },
		bun: { type: "string", default: "bun" },
		lanes: { type: "string", default: "rust,node,sqlite-pipe,bun" }
	}
});
if (!values.input || !values.output)
	throw new Error("Provide --input and a new --output directory.");
const input = resolve(values.input),
	output = resolve(values.output),
	runs = Number(values.runs);
if (!Number.isSafeInteger(runs) || runs < 3 || runs > 9)
	throw new Error("Use 3–9 independent runs.");
const repetitions = Number(values.repetitions);
if (!Number.isSafeInteger(repetitions) || repetitions < 3 || repetitions > 30)
	throw new Error("Use 3–30 repetitions.");
await mkdir(output, { recursive: false });
const worker = fileURLToPath(new URL("./worker.ts", import.meta.url));
interface Sample {
	name: string;
	elapsedMs: number;
	sha256: string;
	rows: number;
}
interface Run {
	lane: string;
	samples: Sample[];
}
const results: Run[] = [];
const build: { answers: Record<string, { sha256: string; rows: number }> } = JSON.parse(
	await readFile(resolve(input, "build.json"), "utf8")
);

async function run(lane: string, round: number) {
	const destination = resolve(output, `${round}-${lane}.json`);
	const command = lane === "bun" ? values.bun : process.execPath;
	if (!command) throw new Error("No runtime configured.");
	const args = [
		...(lane === "bun" ? [] : ["--import", "tsx"]),
		worker,
		"run",
		input,
		destination,
		lane,
		resolve(lane === "sqlite-pipe" ? values.bridge : values.reader)
	];
	const child = spawn(command, args, {
		windowsHide: true,
		detached: process.platform !== "win32",
		stdio: ["ignore", "pipe", "pipe"],
		env: {
			...process.env,
			UE_SHED_SPIKE_REPETITIONS: String(repetitions),
			RAYON_NUM_THREADS: "16"
		}
	});
	let diagnostics = "",
		peakRss = 0,
		samples = 0,
		polling: Promise<void> | undefined,
		failure: Error | undefined;
	child.stdout.on("data", (bytes: Buffer) => {
		diagnostics += bytes.toString();
	});
	child.stderr.on("data", (bytes: Buffer) => {
		diagnostics += bytes.toString();
	});
	const poll = () => {
		if (polling || !child.pid || child.exitCode !== null) return;
		polling = childWorkingSet(child.pid, true)
			.then(async (rss) => {
				peakRss = Math.max(peakRss, rss);
				samples++;
				if (rss > 8 * 1024 ** 3) {
					failure = new Error("STOP: sample exceeded 8 GiB process-tree RSS.");
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
				polling = undefined;
			});
	};
	const timer = setInterval(poll, 1500);
	const deadline = setTimeout(() => {
		failure = new Error("STOP: sample exceeded 10 minutes.");
		void killBenchmarkTree(child);
	}, 600000);
	try {
		await new Promise<void>((accept, reject) => {
			child.once("error", reject);
			child.once("close", (code) =>
				code === 0
					? accept()
					: reject(new Error(`Sample ${lane} exited ${code}: ${diagnostics}`))
			);
		});
		if (failure) throw failure;
	} finally {
		clearInterval(timer);
		clearTimeout(deadline);
		await polling;
	}
	const result: Run = JSON.parse(await readFile(destination, "utf8"));
	for (const sample of result.samples) {
		const expected = build.answers[sample.name];
		if (!expected || expected.sha256 !== sample.sha256 || expected.rows !== sample.rows)
			throw new Error(`PARITY FAILED: ${lane}/${sample.name}`);
	}
	await writeFile(
		resolve(output, `${round}-${lane}.resources.json`),
		JSON.stringify({ peakRss: samples ? peakRss : null, samples, diagnostics })
	);
	results.push(result);
	console.log(`Completed ${lane}, independent run ${round + 1}.`);
}

await withCorpusUnrealLock(async () => {
	const order = values.lanes.split(",");
	if (
		new Set(order).size !== order.length ||
		order.some((lane) => !["rust", "node", "sqlite-pipe", "bun"].includes(lane))
	)
		throw new Error("Invalid lanes.");
	for (let round = 0; round < runs; round++)
		for (const lane of [
			...order.slice(round % order.length),
			...order.slice(0, round % order.length)
		])
			await run(lane, round);
});
const python: {
	rows: GameTextContract.JsonValue[];
	sqlite: string;
	total: number;
	lengthDistribution: GameTextContract.JsonValue[];
} = JSON.parse(
	execFileSync(
		"python",
		[fileURLToPath(new URL("./read.py", import.meta.url)), resolve(input, "facts.sqlite")],
		{ encoding: "utf8", windowsHide: true }
	)
);
const pythonHash = createHash("sha256")
	.update(canonicalLocalizationJson(python.rows))
	.digest("hex");
if (pythonHash !== build.answers["page:50"]?.sha256)
	throw new Error("Independent Python read differs.");
const reportHash = createHash("sha256")
	.update(canonicalLocalizationJson(python.lengthDistribution))
	.digest("hex");
if (reportHash !== build.answers["report:length-distribution"]?.sha256)
	throw new Error("Independent Python report differs.");
await writeFile(
	resolve(output, "python.json"),
	JSON.stringify({
		sqlite: python.sqlite,
		rows: python.rows.length,
		total: python.total,
		sha256: pythonHash,
		reportSha256: reportHash
	})
);
const pooled = new Map<string, { lane: string; name: string; ms: number[]; rows: number }>();
for (const result of results)
	for (const sample of result.samples) {
		const expected = build.answers[sample.name];
		if (!expected || expected.sha256 !== sample.sha256 || expected.rows !== sample.rows)
			throw new Error(`PARITY FAILED: ${result.lane}/${sample.name}`);
		const key = `${result.lane}/${sample.name}`;
		const group = pooled.get(key) ?? {
			lane: result.lane,
			name: sample.name,
			ms: [],
			rows: sample.rows
		};
		group.ms.push(sample.elapsedMs);
		pooled.set(key, group);
	}
const summary = [...pooled.values()].map(({ ms, ...entry }) => {
	ms.sort((a, b) => a - b);
	return {
		...entry,
		samples: ms.length,
		medianMs: ms[Math.floor(ms.length / 2)],
		p95Ms: ms[Math.ceil(ms.length * 0.95) - 1],
		minMs: ms[0],
		maxMs: ms.at(-1)
	};
});
const fingerprints: Record<string, string> = {};
const sourceDirectory = fileURLToPath(new URL(".", import.meta.url));
for (const file of await readdir(sourceDirectory, { recursive: true }))
	if (/\.(?:ts|rs|toml|lock|py)$/u.test(file))
		fingerprints[file.replaceAll("\\", "/")] = createHash("sha256")
			.update(await readFile(resolve(sourceDirectory, file)))
			.digest("hex");
for (const [name, path] of [
	["reader", values.reader],
	["sqlitePipe", values.bridge]
] as const)
	fingerprints[name] = createHash("sha256")
		.update(await readFile(resolve(path)))
		.digest("hex");
await writeFile(
	resolve(output, "summary.json"),
	JSON.stringify(
		{
			source: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
			machine: {
				hostname: hostname(),
				cpu: cpus()[0]?.model,
				threads: cpus().length,
				ram: totalmem()
			},
			runs,
			fingerprints,
			repetitions,
			parity: "all measured answers match the independent fact oracle",
			databaseBytes: (await stat(resolve(input, "facts.sqlite"))).size,
			summary
		},
		null,
		2
	)
);
console.log(`Parity passed; evidence written to ${output}.`);
