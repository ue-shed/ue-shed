import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	findStrayTypeScriptOutput,
	PUBLIC_VERSION,
	validatePackedManifest
} from "./pack-public-packages.ts";

function emitted(source: string) {
	const stem = source.replace(/\.ts$/u, "");
	return [".js", ".js.map", ".d.ts", ".d.ts.map"].map(
		(suffix) => `package/dist/${stem}${suffix}`
	);
}

const sourceFiles = ["index.ts", "review-preview.ts", "contracts/review.ts"];
const cleanFiles = [
	"package/package.json",
	"package/README.md",
	"package/LICENSE",
	...sourceFiles.flatMap(emitted)
];

test("accepts dist files that the current sources emit", () => {
	assert.deepEqual(findStrayTypeScriptOutput({ files: cleanFiles, sourceFiles }), []);
	assert.deepEqual(
		findStrayTypeScriptOutput({
			files: cleanFiles,
			sourceFiles: ["index.ts", "review-preview.ts", "contracts\\review.ts"]
		}),
		[],
		"Windows-relative source paths must match packed paths"
	);
});

test("rejects the stale cameras 0.9.1 build output", () => {
	// 0.9.1 shipped these from an uncleaned dist after their sources were renamed or removed.
	const stale = ["json-file.ts", "review-preview-live.ts", "sha256.ts"].flatMap(emitted);
	assert.deepEqual(
		findStrayTypeScriptOutput({ files: [...cleanFiles, ...stale], sourceFiles }),
		stale
	);
});

test("rejects dist files with no TypeScript output shape", () => {
	assert.deepEqual(
		findStrayTypeScriptOutput({
			files: [...cleanFiles, "package/dist/index.tsbuildinfo", "package/dist/notes.txt"],
			sourceFiles
		}),
		["package/dist/index.tsbuildinfo", "package/dist/notes.txt"]
	);
});

test("fails pack validation with the stray files named", () => {
	const manifest = {
		name: "@ue-shed/cameras",
		version: PUBLIC_VERSION,
		license: "MIT",
		repository: { url: "git+https://github.com/ue-shed/ue-shed.git" },
		main: "./dist/index.js",
		types: "./dist/index.d.ts",
		exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } }
	};
	const validate = (files: readonly string[]) =>
		validatePackedManifest({
			manifest,
			manifestRaw: JSON.stringify(manifest),
			expectedName: manifest.name,
			expectedVersion: PUBLIC_VERSION,
			files,
			typeScriptSources: sourceFiles
		});
	assert.deepEqual(validate(cleanFiles), []);
	const failures = validate([...cleanFiles, "package/dist/sha256.js"]);
	assert.equal(failures.length, 1);
	assert.match(failures[0] ?? "", /no current source emits.*package\/dist\/sha256\.js/u);
});

test("package builds start from an empty dist", async () => {
	const packageDirectory = await mkdtemp(join(tmpdir(), "ue-shed-clean-dist-"));
	try {
		await writeFile(join(packageDirectory, "package.json"), "{}\n");
		await mkdir(join(packageDirectory, "dist", "nested"), { recursive: true });
		await writeFile(join(packageDirectory, "dist", "nested", "retired.js"), "");
		const result = spawnSync(
			process.execPath,
			[join(import.meta.dirname, "clean-package-dist.ts")],
			{ cwd: packageDirectory, encoding: "utf8" }
		);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(existsSync(join(packageDirectory, "dist")), false);
		assert.equal(existsSync(join(packageDirectory, "package.json")), true);
	} finally {
		await rm(packageDirectory, { recursive: true, force: true });
	}
});
