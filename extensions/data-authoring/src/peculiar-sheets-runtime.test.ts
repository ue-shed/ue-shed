import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Peculiar Sheets ships precompiled Solid output. Its delegated handlers only fire when they use the
// event key of the renderer it runs against; a mismatch renders the grid but drops every keystroke.
const requireFromExtension = createRequire(import.meta.url);
const delegatedAssignment = /\.([_$]+)(click|contextmenu|input|keydown|keyup|mousedown) = /g;

function packageRoot(entry: string, name: string): string {
	let directory = dirname(entry);
	while (!existsSync(join(directory, "package.json")) || !isPackage(directory, name)) {
		const parent = dirname(directory);
		if (parent === directory) throw new Error(`No ${name} package above ${entry}`);
		directory = parent;
	}
	return realpathSync(directory);
}

function isPackage(directory: string, name: string): boolean {
	const manifest = readFileSync(join(directory, "package.json"), "utf8");
	return manifest.includes(`"name": "${name}"`);
}

describe("Peculiar Sheets runtime compatibility", () => {
	const sheetsRoot = packageRoot(
		requireFromExtension.resolve("peculiar-sheets"),
		"peculiar-sheets"
	);
	const requireFromSheets = createRequire(join(sheetsRoot, "package.json"));
	const webRoot = packageRoot(requireFromSheets.resolve("@solidjs/web"), "@solidjs/web");

	it("compiles delegated handlers with the installed renderer's event key", () => {
		const renderer = readFileSync(join(webRoot, "dist", "web.js"), "utf8");
		const eventKey = /const EVENT_KEY = "([^"]+)";/.exec(renderer)?.[1];
		expect(eventKey).toBeDefined();
		const grid = readFileSync(join(sheetsRoot, "dist", "index.js"), "utf8");
		const prefixes = new Set([...grid.matchAll(delegatedAssignment)].map((match) => match[1]));
		expect(prefixes.size).toBeGreaterThan(0);
		expect([...prefixes]).toEqual([eventKey]);
	});

	it("shares the renderer the Workbench resolves", () => {
		const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
		const requireFromWorkbench = createRequire(
			join(repositoryRoot, "apps", "workbench", "package.json")
		);
		const workbenchWeb = packageRoot(
			requireFromWorkbench.resolve("@solidjs/web"),
			"@solidjs/web"
		);
		expect(workbenchWeb).toBe(webRoot);
	});
});
