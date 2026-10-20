import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("the full Unreal gate includes every native automation test", () => {
	const plugins = fileURLToPath(new URL("../unreal/Plugins/", import.meta.url));
	const nativeTests = readdirSync(plugins, { recursive: true, encoding: "utf8" })
		.filter((file) => file.endsWith(".cpp"))
		.flatMap((file) =>
			[
				...readFileSync(join(plugins, file), "utf8").matchAll(
					/IMPLEMENT_\w+_AUTOMATION_TEST\s*\([^,]+,\s*"([^"]+)"/gu
				)
			].map((match) => match[1])
		);
	const gate = readFileSync(new URL("./test-unreal-plugins.ts", import.meta.url), "utf8");
	const selectedTests = [...gate.matchAll(/"(UEShed\.[^"]*[^.])"/gu)].map((match) => match[1]);
	assert.ok(nativeTests.length > 0);
	assert.deepEqual(new Set(selectedTests), new Set(nativeTests));
});
