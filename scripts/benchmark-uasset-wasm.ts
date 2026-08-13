import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { cpus, platform, release, totalmem } from "node:os";
import { performance } from "node:perf_hooks";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const wasmPackage = join(
	repositoryRoot,
	"packages",
	"uasset-inspection-wasm",
	"dist",
	"wasm",
	"node",
	"uasset_inspection_wasm.js"
);
const nativeExecutable = join(
	repositoryRoot,
	"target",
	"release",
	process.platform === "win32" ? "uasset.exe" : "uasset"
);
const fixture = join(
	repositoryRoot,
	"fixtures",
	"unreal-project",
	"Content",
	"Fixture",
	"Authoring",
	"DT_LargeScalars.uasset"
);
const bytes = readFileSync(fixture);
const displayPath = relative(repositoryRoot, fixture).replaceAll("\\", "/");
const wasm = (await import(pathToFileURL(wasmPackage).href)) as {
	readonly inspect: (path: string, bytes: Uint8Array) => string;
};
const exampleOutput = wasm.inspect(displayPath, bytes);
const nativeParityOutput = JSON.parse(
	execFileSync(nativeExecutable, ["inspect", "-", "--format", "json"], {
		cwd: repositoryRoot,
		encoding: "utf8",
		input: bytes,
		maxBuffer: 64 * 1024 * 1024
	})
);
nativeParityOutput.path = displayPath;
assert.deepEqual(
	JSON.parse(exampleOutput),
	nativeParityOutput,
	"Benchmark producers must return identical inspection evidence"
);

function distribution(samples: readonly number[]) {
	const sorted = [...samples].sort((left, right) => left - right);
	const percentile = (fraction: number) =>
		sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
	return {
		minimumMs: sorted[0],
		meanMs: samples.reduce((total, sample) => total + sample, 0) / samples.length,
		p50Ms: percentile(0.5),
		p95Ms: percentile(0.95),
		maximumMs: sorted.at(-1),
		samplesMs: samples
	};
}

function measure(iterations: number, operation: () => string) {
	const samples: number[] = [];
	for (let iteration = 0; iteration < iterations; iteration += 1) {
		const started = performance.now();
		const output = operation();
		const elapsed = performance.now() - started;
		if (JSON.parse(output).schema_version !== 8) {
			throw new Error("Benchmark producer returned an unexpected schema version");
		}
		samples.push(elapsed);
	}
	return distribution(samples);
}

wasm.inspect(displayPath, bytes);
execFileSync(nativeExecutable, ["inspect", fixture, "--format", "json"], {
	cwd: repositoryRoot,
	encoding: "utf8",
	maxBuffer: 64 * 1024 * 1024
});

const result = {
	schemaVersion: 1,
	revision: {
		commit: execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: repositoryRoot,
			encoding: "utf8"
		}).trim(),
		dirty:
			execFileSync("git", ["status", "--porcelain"], {
				cwd: repositoryRoot,
				encoding: "utf8"
			}).length > 0
	},
	environment: {
		operatingSystem: `${platform()} ${release()}`,
		cpu: cpus()[0]?.model ?? "unknown",
		logicalCpuCount: cpus().length,
		memoryBytes: totalmem(),
		node: process.version,
		rust: execFileSync("rustc", ["--version"], { encoding: "utf8" }).trim()
	},
	workload: displayPath,
	fileBytes: bytes.byteLength,
	outputBytes: Buffer.byteLength(exampleOutput),
	wasmModuleBytes: statSync(
		join(
			repositoryRoot,
			"packages",
			"uasset-inspection-wasm",
			"dist",
			"wasm",
			"node",
			"uasset_inspection_wasm_bg.wasm"
		)
	).size,
	note: "WASM is a long-lived in-process call. Native includes fresh process startup and file I/O; both include decode and JSON serialization.",
	scenarios: {
		"wasm.inspect.long_lived": {
			iterations: 20,
			distribution: measure(20, () => wasm.inspect(displayPath, bytes))
		},
		"native.inspect.fresh_process": {
			iterations: 10,
			distribution: measure(10, () =>
				execFileSync(nativeExecutable, ["inspect", fixture, "--format", "json"], {
					cwd: repositoryRoot,
					encoding: "utf8",
					maxBuffer: 64 * 1024 * 1024
				})
			)
		}
	}
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
