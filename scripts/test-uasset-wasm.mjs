import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageNodeEntry = join(
	repositoryRoot,
	"packages",
	"uasset-inspection-wasm",
	"dist",
	"node.js"
);
const nativeExecutable = join(
	repositoryRoot,
	"target",
	"release",
	process.platform === "win32" ? "uasset.exe" : "uasset"
);
const fixtureRoot = join(repositoryRoot, "fixtures", "unreal-project");
const fixtures = [
	"Content/Fixture/Authoring/DT_Scalars.uasset",
	"Content/Fixture/Authoring/DT_LargeScalars.uasset",
	"Content/Fixture/Input/IMC_Fixture.uasset",
	"Content/Fixture/Audits/Textures/T_Audit_NonPowerOfTwo_300x180.uasset",
	"Content/Fixture/Animation/A_FixtureMotion.uasset",
	"Content/Fixture/Text/ST_Game.uasset",
	"Content/Fixture/Cameras/L_CameraLoad.umap"
].map((path) => join(fixtureRoot, path));
const projectionFixtures = [
	{ path: join(fixtureRoot, "Content/Fixture/Text/DA_TextOccurrences.uasset"), kind: "text" },
	{
		path: join(
			fixtureRoot,
			"Content/Fixture/Audits/Textures/T_Audit_NonPowerOfTwo_300x180.uasset"
		),
		kind: "texture"
	}
];

const wasm = await import(pathToFileURL(packageNodeEntry));
const runtime = wasm.createNodeRuntime();

assert.equal(
	`uasset ${runtime.version()}`,
	execFileSync(nativeExecutable, ["--version"], { encoding: "utf8" }).trim()
);
assert.equal(runtime.limits.maxInputBytes, 64 * 1024 * 1024);
assert.equal(runtime.limits.maxOutputBytes, 64 * 1024 * 1024);

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

	assert.deepEqual(
		runtime.inspect(displayPath, bytes),
		nativeInspection,
		`${displayPath} must match native inspection`
	);

	const repeated = runtime.inspect(displayPath, bytes);
	assert.deepEqual(
		repeated,
		nativeInspection,
		`${displayPath} must be stable across repeated calls`
	);
}

for (const { path: fixture, kind } of projectionFixtures) {
	const displayPath = relative(repositoryRoot, fixture).replaceAll("\\", "/");
	const bytes = readFileSync(fixture);
	const nativeProjection = readNativeProjection(fixture, kind, displayPath);
	const wasmProjection =
		kind === "text"
			? runtime.extractText(displayPath, bytes)
			: runtime.extractTextures(displayPath, bytes);
	assert.deepEqual(
		wasmProjection,
		nativeProjection,
		`${displayPath} ${kind} projection must match native`
	);
}

const unsupported = runtime.inspect("BigEndian.uasset", Uint8Array.from([0x9e, 0x2a, 0x83, 0xc1]));
assert.equal(unsupported.schema_version, 8);
assert.equal(unsupported.status, "error");
assert.equal(unsupported.path, "BigEndian.uasset");
assert.equal(unsupported.kind, "unsupported_capability");

const malformed = runtime.inspect("Broken.uasset", Uint8Array.from([0, 1, 2, 3]));
assert.equal(malformed.schema_version, 8);
assert.equal(malformed.status, "error");
assert.equal(malformed.path, "Broken.uasset");
assert.equal(malformed.kind, "unsupported_format");

const malformedText = runtime.extractText("Broken.uasset", Uint8Array.from([0, 1, 2, 3]));
assert.equal(malformedText.schema_version, 1);
assert.equal(malformedText.status, "error");
assert.equal(malformedText.path, "Broken.uasset");
assert.equal(malformedText.kind, "unsupported_format");

const narrowRuntime = wasm.createNodeRuntime({ maxInputBytes: 4 });
assert.throws(
	() => narrowRuntime.inspect("TooLarge.uasset", new Uint8Array(5)),
	(error) => error?.code === "UE_SHED_UASSET_WASM_INPUT_LIMIT"
);

process.stdout.write(
	`WASM inspection parity passed for ${fixtures.length} fixtures, compact projections passed for ${projectionFixtures.length} fixtures, and typed failures/limits passed.\n`
);

function readNativeProjection(fixture, projection, displayPath) {
	const lines = execFileSync(
		nativeExecutable,
		["scan", fixtureRoot, "--path", fixture, "--projection", projection, "--concurrency", "1"],
		{ cwd: repositoryRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
	)
		.trim()
		.split(/\r?\n/)
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line));
	const eventPrefix = projection === "text" ? "text" : "texture";
	const packageEvent = lines.find((line) => line.event === `${eventPrefix}_package`);
	assert.ok(packageEvent, `${displayPath} must produce a ${eventPrefix} package event`);
	if (projection === "text") {
		return {
			schema_version: 1,
			status: packageEvent.status,
			path: displayPath,
			occurrences: lines
				.filter((line) => line.event === "text_occurrence")
				.map((line) => line.occurrence),
			coverage_gaps: lines
				.filter((line) => line.event === "text_coverage_gap")
				.map((line) => line.coverage_gap),
			diagnostics: packageEvent.diagnostics
		};
	}
	return {
		schema_version: 1,
		status: packageEvent.status,
		path: displayPath,
		records: lines.filter((line) => line.event === "texture_record").map((line) => line.record),
		diagnostics: packageEvent.diagnostics
	};
}
