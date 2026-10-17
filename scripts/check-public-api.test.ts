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
