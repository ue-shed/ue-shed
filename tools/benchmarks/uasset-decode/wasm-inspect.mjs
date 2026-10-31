#!/usr/bin/env node
// Benchmarks the site worker's inspect sequence two ways: four separate runtime
// calls (A) versus one parse-once package handle (B). No new dependencies.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const entry = join(repositoryRoot, "packages", "uasset-inspection-wasm", "dist", "node.js");

function parseArgs(argv) {
	const args = { list: undefined, out: undefined, runs: 5 };
	for (let index = 0; index < argv.length; index += 1) {
		const flag = argv[index];
		if (flag === "--list") args.list = argv[++index];
		else if (flag === "--out") args.out = argv[++index];
		else if (flag === "--runs") args.runs = Number(argv[++index]);
		else throw new Error(`unknown argument: ${flag}`);
	}
	if (!args.list) throw new Error("--list <file> is required");
	if (!Number.isSafeInteger(args.runs) || args.runs < 1) {
		throw new Error("--runs must be a positive integer");
	}
	return args;
}

function workerSequence(runtime, path, bytes) {
	const inspection = runtime.inspect(path, bytes);
	const isSequence =
		inspection.status !== "error" &&
		inspection.assets.some((asset) => asset.class_path?.endsWith(".LevelSequence"));
	return {
		inspection,
		authoringOutput:
			inspection.status !== "error" &&
			inspection.assets.some(
				(asset) => asset.kind === "DataTable" || asset.kind === "CompositeDataTable"
			)
				? runtime.extractAuthoringTable(path, bytes)
				: {
						schema_version: 1,
						status: "error",
						path,
						kind: "unsupported_capability",
						message: "package contains no supported DataTable export"
					},
		sequenceOutput: isSequence
			? runtime.extractLevelSequences(path, bytes)
			: { schema_version: 1, status: "complete", path, sequences: [], diagnostics: [] },
		output: runtime.extractBlueprints(path, bytes)
	};
}

function workerSequenceWithHandle(runtime, path, bytes) {
	const handle = runtime.openPackage(path, bytes);
	try {
		const inspection = handle.inspect();
		const isSequence =
			inspection.status !== "error" &&
			inspection.assets.some((asset) => asset.class_path?.endsWith(".LevelSequence"));
		return {
			inspection,
			authoringOutput:
				inspection.status !== "error" &&
				inspection.assets.some(
					(asset) => asset.kind === "DataTable" || asset.kind === "CompositeDataTable"
				)
					? handle.extractAuthoringTable()
					: {
							schema_version: 1,
							status: "error",
							path,
							kind: "unsupported_capability",
							message: "package contains no supported DataTable export"
						},
			sequenceOutput: isSequence
				? handle.extractLevelSequences()
				: { schema_version: 1, status: "complete", path, sequences: [], diagnostics: [] },
			output: handle.extractBlueprints()
		};
	} finally {
		handle.free();
	}
}

function median(values) {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

const args = parseArgs(process.argv.slice(2));
const { createNodeRuntime } = await import(pathToFileURL(entry).href);
const runtime = createNodeRuntime();
const paths = readFileSync(args.list, "utf8")
	.split(/\r?\n/)
	.map((line) => line.trim())
	.filter((line) => line.length > 0 && !line.startsWith("#"));

const packages = [];
let mismatches = 0;
for (const path of paths) {
	const bytes = new Uint8Array(readFileSync(path));
	const aTimes = [];
	const bTimes = [];
	let mismatch = false;
	for (let run = 0; run < args.runs; run += 1) {
		const order = run % 2 === 0 ? ["a", "b"] : ["b", "a"];
		for (const which of order) {
			const start = performance.now();
			const result =
				which === "a"
					? workerSequence(runtime, path, bytes)
					: workerSequenceWithHandle(runtime, path, bytes);
			const elapsed = performance.now() - start;
			(which === "a" ? aTimes : bTimes).push(elapsed);
			void result;
		}
	}
	// Correctness is checked outside the timed runs with one fresh pair.
	try {
		assert.deepEqual(
			workerSequenceWithHandle(runtime, path, bytes),
			workerSequence(runtime, path, bytes)
		);
	} catch {
		mismatch = true;
	}
	if (mismatch) mismatches += 1;
	packages.push({
		path,
		bytes: bytes.byteLength,
		a_ms: median(aTimes),
		b_ms: median(bTimes),
		mismatch
	});
	console.log(
		`${path} bytes=${bytes.byteLength} a_ms=${median(aTimes).toFixed(3)} b_ms=${median(bTimes).toFixed(3)}${mismatch ? " MISMATCH" : ""}`
	);
}

const totals = {
	a_ms: packages.reduce((total, entry) => total + entry.a_ms, 0),
	b_ms: packages.reduce((total, entry) => total + entry.b_ms, 0)
};
const report = { packages, totals };
if (args.out) writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);
console.log(
	`packages=${packages.length} runs=${args.runs} a_ms=${totals.a_ms.toFixed(3)} b_ms=${totals.b_ms.toFixed(3)} speedup=${totals.b_ms > 0 ? (totals.a_ms / totals.b_ms).toFixed(2) : "n/a"}x mismatches=${mismatches}`
);
if (mismatches > 0) process.exit(1);
