import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildUnlessUnchanged, moduleManifestOutputs } from "./build-stamp.ts";

test("rebuilds when a module the manifest maps is missing", (context) => {
	const root = mkdtempSync(join(tmpdir(), "ue-shed-build-stamp-"));
	context.after(() => rmSync(root, { force: true, recursive: true }));
	const binaries = join(root, "Binaries", "Win64");
	const manifest = join(binaries, "UnrealEditor.modules");
	const dll = join(binaries, "UnrealEditor-Fixture.dll");
	const stampFile = join(root, "Intermediate", "stamp.sha256");
	let builds = 0;
	const build = () =>
		buildUnlessUnchanged({
			stampFile,
			stamp: "inputs",
			outputs: moduleManifestOutputs(manifest),
			build: () => {
				builds += 1;
				mkdirSync(binaries, { recursive: true });
				writeFileSync(
					manifest,
					JSON.stringify({
						BuildId: "1",
						Modules: { Fixture: "UnrealEditor-Fixture.dll" }
					})
				);
				writeFileSync(dll, "");
			}
		});

	build();
	build();
	assert.equal(builds, 1);

	rmSync(dll);
	assert.deepEqual(moduleManifestOutputs(manifest), [manifest, dll]);
	build();
	assert.equal(builds, 2);
});

test("lists only the manifest while it is missing or unreadable", (context) => {
	const root = mkdtempSync(join(tmpdir(), "ue-shed-build-stamp-"));
	context.after(() => rmSync(root, { force: true, recursive: true }));
	const manifest = join(root, "UnrealEditor.modules");
	assert.deepEqual(moduleManifestOutputs(manifest), [manifest]);
	writeFileSync(manifest, "{ not json");
	assert.deepEqual(moduleManifestOutputs(manifest), [manifest]);
});
