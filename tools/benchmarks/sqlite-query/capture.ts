/** Consolidate portable evidence; preserve original file hashes without embedding local paths. */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error("capture.ts BENCHMARK_ROOT NEW_EVIDENCE_JSON");
const root = resolve(input);
const Stats = Schema.Struct({
	lane: Schema.String,
	name: Schema.String,
	rows: Schema.Int,
	samples: Schema.Int,
	medianMs: Schema.Number,
	p95Ms: Schema.Number,
	minMs: Schema.Number,
	maxMs: Schema.Number
});
const Summary = Schema.Struct({
	source: Schema.String,
	machine: Schema.Struct({ cpu: Schema.String, threads: Schema.Int, ram: Schema.Number }),
	runs: Schema.Int,
	repetitions: Schema.Int,
	parity: Schema.String,
	databaseBytes: Schema.Number,
	fingerprints: Schema.Record(Schema.String, Schema.String),
	summary: Schema.Array(Stats)
});
const Sample = Schema.Struct({
	name: Schema.String,
	round: Schema.Int,
	elapsedMs: Schema.Number,
	rows: Schema.Int,
	sha256: Schema.String,
	profile: Schema.optionalKey(
		Schema.Struct({
			stageSeconds: Schema.Record(Schema.String, Schema.Number),
			batches: Schema.Int,
			batchBytes: Schema.Number,
			creditStallMs: Schema.Number
		})
	),
	batchBytes: Schema.optionalKey(Schema.Number),
	callbackGap: Schema.Struct({ maximumDelayMs: Schema.Number, p99DelayMs: Schema.Number })
});
const Run = Schema.Struct({
	lane: Schema.String,
	setupMs: Schema.Number,
	version: Schema.Json,
	runtime: Schema.Record(Schema.String, Schema.String),
	memory: Schema.Json,
	warmups: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
	samples: Schema.Array(Sample)
});
const Resources = Schema.Struct({ peakRss: Schema.NullOr(Schema.Number), samples: Schema.Int });
const Build = Schema.Struct({
	buildMs: Schema.Number,
	counts: Schema.Struct({ strings: Schema.Int, cultures: Schema.Int }),
	rows: Schema.Int,
	version: Schema.Json,
	options: Schema.Json,
	plans: Schema.Json,
	answers: Schema.Record(
		Schema.String,
		Schema.Struct({ sha256: Schema.String, rows: Schema.Int })
	)
});
const Input = Schema.Struct({
	scale: Schema.Number,
	seed: Schema.Int,
	rows: Schema.Int,
	preparedMs: Schema.Number,
	nativeJoinMs: Schema.Number,
	exportMs: Schema.Number
});
const decodeSummary = Schema.decodeUnknownSync(Schema.fromJsonString(Summary));
const decodeRun = Schema.decodeUnknownSync(Schema.fromJsonString(Run));
const decodeResources = Schema.decodeUnknownSync(Schema.fromJsonString(Resources));
const decodeBuild = Schema.decodeUnknownSync(Schema.fromJsonString(Build));
const decodeInput = Schema.decodeUnknownSync(Schema.fromJsonString(Input));
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));
async function hash(path: string) {
	const digest = createHash("sha256");
	for await (const bytes of createReadStream(path)) digest.update(bytes);
	return digest.digest("hex");
}
async function cohort(name: string, directory: string, measurements: string) {
	const source = resolve(root, directory),
		runs = resolve(root, measurements);
	const summary = decodeSummary(await readFile(resolve(runs, "summary.json"), "utf8"));
	const samples = [];
	for (const file of (await readdir(runs))
		.filter((name) => /^\d+-(?:rust|node|bun|sqlite-pipe)\.json$/u.test(name))
		.sort()) {
		const path = resolve(runs, file);
		samples.push({
			file,
			sha256: await hash(path),
			...decodeRun(await readFile(path, "utf8")),
			resources: decodeResources(
				await readFile(path.replace(/\.json$/u, ".resources.json"), "utf8")
			)
		});
	}
	return {
		name,
		input:
			name === "controls"
				? null
				: decodeInput(await readFile(resolve(source, "input.json"), "utf8")),
		factBytes: (await stat(resolve(source, "facts.json"))).size,
		factSha256: await hash(resolve(source, "facts.json")),
		databaseSha256: await hash(resolve(source, "facts.sqlite")),
		build: decodeBuild(await readFile(resolve(source, "build.json"), "utf8")),
		summary,
		samples,
		python: decodeJson(await readFile(resolve(runs, "python.json"), "utf8"))
	};
}
const cohorts = [];
for (const name of ["controls", "tiny", "small", "medium"])
	cohorts.push(await cohort(name, name, `${name}-final`));
const projection = await cohort("medium-projection-control", "medium", "medium-projection");
const tuned = await cohort("medium-count-tuning", "medium-counts", "medium-counts-final");
await writeFile(
	resolve(output),
	JSON.stringify(
		{
			date: "2026-11-06",
			scope: "Game Text retained-fact query spike; not complete-store or migration acceptance",
			cohorts,
			projectionControl: projection,
			countTuning: tuned,
			countTuningSql: decodeJson(
				await readFile(resolve(root, "medium-counts/tuning.json"), "utf8")
			),
			projectionPatchSha256: await hash(
				fileURLToPath(new URL("./rust-projection.patch", import.meta.url))
			),
			lifecycle: decodeJson(
				await readFile(resolve(root, "medium-lifecycle/results.json"), "utf8")
			),
			projectionParity: decodeJson(
				await readFile(resolve(root, "projection-parity/results.json"), "utf8")
			),
			rawEvidence:
				"Original local files remain in the worktree test-results/sqlite-spike directory. Consolidation omits cumulative IO counters and hostnames; every operation time, result hash, batching volume and measured stage is retained."
		},
		null,
		2
	),
	{ flag: "wx" }
);
