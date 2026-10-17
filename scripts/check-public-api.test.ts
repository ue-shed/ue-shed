import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkPublicApi } from "./check-public-api.ts";

test("public contracts cannot grow through wildcard exports or lose caller documentation", async () => {
	const root = await mkdtemp(join(tmpdir(), "ue-shed-public-api-"));
	try {
		const directory = join(root, "packages/protocol");
		await mkdir(join(directory, "src"), { recursive: true });
		await writeFile(
			join(directory, "package.json"),
			JSON.stringify({
				name: "@ue-shed/protocol",
				type: "module",
				exports: { ".": "./src/index.ts" }
			})
		);
		await writeFile(join(directory, "src/value.ts"), "export const maximum = 12;\n");
		await writeFile(join(directory, "src/index.ts"), 'export * from "./value.js";\n');
		assert(
			checkPublicApi(root).some((failure) => failure.includes("must list exports by name"))
		);
		await writeFile(join(directory, "src/index.ts"), 'export { maximum } from "./value.js";\n');
		assert(
			checkPublicApi(root).some(
				(failure) => failure.includes("maximum") && failure.includes("JSDoc")
			)
		);
		await writeFile(
			join(directory, "src/value.ts"),
			"/** Maximum active requests; exceeding the limit requires queuing. */\nexport const maximum = 12;\nexport const privateDetail = true;\n"
		);
		assert.deepEqual(checkPublicApi(root), []);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("documentation enforcement covers every reviewed SDK and focused entry point", async () => {
	const root = await mkdtemp(join(tmpdir(), "ue-shed-sdk-docs-"));
	const packages = [
		"protocol",
		"unreal-connection",
		"localization",
		"unreal-assets",
		"engine",
		"cameras",
		"host",
		"game-text"
	];
	try {
		for (const name of packages) {
			const directory = join(root, "packages", name);
			await mkdir(join(directory, "src"), { recursive: true });
			await writeFile(
				join(directory, "package.json"),
				JSON.stringify({
					name: `@ue-shed/${name}`,
					type: "module",
					exports: { ".": "./src/index.ts", "./focused": "./src/focused.ts" }
				})
			);
			await writeFile(join(directory, "src/index.ts"), "export {};\n");
			await writeFile(join(directory, "src/focused.ts"), "export const undocumented = 1;\n");
		}
		const failures = checkPublicApi(root);
		assert.equal(failures.length, packages.length);
		for (const name of packages)
			assert(
				failures.some((failure) =>
					failure.includes(`${name}/focused needs caller-facing JSDoc`)
				)
			);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
