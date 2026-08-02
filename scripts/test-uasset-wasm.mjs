import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const wasmPackage = join(
	repositoryRoot,
	"target",
	"uasset-inspection-wasm-node",
	"uasset_inspection_wasm.js"
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
	),
	join(
		repositoryRoot,
		"fixtures",
		"unreal-project",
		"Content",
		"Fixture",
		"Audits",
		"Textures",
		"T_Audit_NonPowerOfTwo_300x180.uasset"
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

	const nativeProjection = (projection) => {
		const lines = execFileSync(
			nativeExecutable,
			[
				"scan",
				join(repositoryRoot, "fixtures", "unreal-project"),
				"--path",
				fixture,
				"--projection",
				projection,
				"--concurrency",
				"1"
			],
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
			records: lines
				.filter((line) => line.event === "texture_record")
				.map((line) => line.record),
			diagnostics: packageEvent.diagnostics
		};
	};

	assert.deepEqual(
		JSON.parse(wasm.extract_text(displayPath, bytes)),
		nativeProjection("text"),
		`${displayPath} text projection must match native`
	);
	assert.deepEqual(
		JSON.parse(wasm.extract_textures(displayPath, bytes)),
		nativeProjection("texture"),
		`${displayPath} texture projection must match native`
	);
}

const malformed = JSON.parse(wasm.inspect("Broken.uasset", Uint8Array.from([0, 1, 2, 3])));
assert.equal(malformed.schema_version, 8);
assert.equal(malformed.status, "error");
assert.equal(malformed.path, "Broken.uasset");
assert.equal(malformed.kind, "unsupported_format");

const malformedText = JSON.parse(wasm.extract_text("Broken.uasset", Uint8Array.from([0, 1, 2, 3])));
assert.equal(malformedText.schema_version, 1);
assert.equal(malformedText.status, "error");
assert.equal(malformedText.path, "Broken.uasset");
assert.equal(malformedText.kind, "unsupported_format");

process.stdout.write(
	`WASM inspection and compact-projection parity passed for ${fixtures.length} fixtures plus malformed input.\n`
);
