import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const wasmPackage = join(
	repositoryRoot,
	"target",
	"uasset-parser-wasm-node",
	"uasset_parser_wasm.js"
);
const nativeExecutable = join(
	repositoryRoot,
	"target",
	"release",
	process.platform === "win32" ? "uasset.exe" : "uasset"
);
const fixtures = [
	join(
		repositoryRoot,
		"fixtures",
		"unreal-project",
		"Content",
		"Fixture",
		"Authoring",
		"DT_Scalars.uasset"
	),
	join(
		repositoryRoot,
		"fixtures",
		"unreal-project",
		"Content",
		"Fixture",
		"Input",
		"IMC_Fixture.uasset"
	)
];

const wasm = await import(pathToFileURL(wasmPackage));

assert.equal(
	`uasset ${wasm.version()}`,
	execFileSync(nativeExecutable, ["--version"], { encoding: "utf8" }).trim()
);

for (const fixture of fixtures) {
	const displayPath = relative(repositoryRoot, fixture).replaceAll("\\", "/");
	const bytes = readFileSync(fixture);
	const nativeOutput = execFileSync(nativeExecutable, ["inspect", "-", "--format", "json"], {
		cwd: repositoryRoot,
		encoding: "utf8",
		input: bytes,
		maxBuffer: 64 * 1024 * 1024
	});
	const nativeInspection = JSON.parse(nativeOutput);
	nativeInspection.path = displayPath;

	const wasmOutput = wasm.inspect(displayPath, bytes);
	const wasmInspection = JSON.parse(wasmOutput);

	assert.deepEqual(
		wasmInspection,
		nativeInspection,
		`${displayPath} must match native inspection`
	);
}

const malformed = JSON.parse(wasm.inspect("Broken.uasset", Uint8Array.from([0, 1, 2, 3])));
assert.equal(malformed.schema_version, 7);
assert.equal(malformed.status, "error");
assert.equal(malformed.path, "Broken.uasset");
assert.equal(malformed.kind, "unsupported_format");

process.stdout.write(
	`WASM inspection parity passed for ${fixtures.length} fixtures plus malformed input.\n`
);
