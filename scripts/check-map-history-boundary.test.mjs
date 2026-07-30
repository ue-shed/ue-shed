import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const allowedPackage = join(repositoryRoot, "packages", "map-history");
const workspaceRoots = ["apps", "examples", "extensions", "packages"];

async function collectFiles(directory, predicate) {
	const files = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		if (entry.name === "node_modules" || entry.name === "dist") continue;
		const path = join(directory, entry.name);
		if (entry.isDirectory()) files.push(...(await collectFiles(path, predicate)));
		else if (entry.isFile() && predicate(path)) files.push(path);
	}
	return files;
}

function isInsideAllowedPackage(path) {
	return path === allowedPackage || path.startsWith(`${allowedPackage}${sep}`);
}

test("confines p4client-ts to @ue-shed/map-history", async () => {
	const files = (
		await Promise.all(
			workspaceRoots.map((root) =>
				collectFiles(join(repositoryRoot, root), (path) => {
					return path.endsWith("package.json") || /\.[cm]?[jt]sx?$/.test(path);
				})
			)
		)
	).flat();
	const violations = [];

	for (const path of files) {
		if (isInsideAllowedPackage(path)) continue;
		const contents = await readFile(path, "utf8");
		if (contents.includes("p4client-ts")) {
			violations.push(relative(repositoryRoot, path).replaceAll(sep, "/"));
		}
	}

	assert.deepEqual(violations, []);
});
