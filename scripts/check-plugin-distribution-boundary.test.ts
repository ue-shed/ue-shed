import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const root = join(import.meta.dirname, "..", "packages", "plugin-distribution");

async function sourceFiles(directory: string): Promise<string[]> {
	const files: string[] = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
		else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.includes(".test.")) {
			files.push(path);
		}
	}
	return files;
}

test("plugin distribution stays independent of product hosts and studio repositories", async () => {
	const forbidden = [
		/apps[\\/]workbench/iu,
		/from\s+["']electron/iu,
		/from\s+["'][^"']*electroswag/iu,
		/from\s+["'][^"']*manabreak/iu,
		/from\s+["'][^"']*perforce/iu
	];
	for (const path of await sourceFiles(join(root, "src"))) {
		const source = await readFile(path, "utf8");
		for (const pattern of forbidden) {
			assert.doesNotMatch(source, pattern, `${path} crosses the public package boundary`);
		}
	}
	// SAFETY: this repository-owned package manifest is immediately limited to two optional maps.
	const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
		dependencies?: Record<string, string>;
		peerDependencies?: Record<string, string>;
	};
	assert.deepEqual(manifest.dependencies ?? {}, {});
	assert.deepEqual(Object.keys(manifest.peerDependencies ?? {}), ["effect"]);
});
