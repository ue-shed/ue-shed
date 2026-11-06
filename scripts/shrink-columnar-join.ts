import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Schema } from "effect";
import { withJoinCache } from "./columnar-join.test-support.ts";
import {
	JoinFuzzInput,
	joinFuzzException,
	compareJoinFuzzInput,
	shrinkJoinFuzzInput
} from "./columnar-join-fuzz.test-support.ts";

const directory = resolve("test-results/codex/phase6-fuzz");
const report = Schema.decodeSync(
	Schema.fromJsonString(
		Schema.Struct({
			count: Schema.Int,
			first: Schema.Int,
			failures: Schema.Array(
				Schema.Tuple([
					Schema.String,
					Schema.Struct({ seed: Schema.Int, detail: Schema.String })
				])
			)
		})
	)
)(await readFile(resolve(directory, "latest.json"), "utf8"));
const reproduced = new Set<string>();
for (const [field, { seed }] of report.failures) {
	const family = `${seed}:${field.split(".").slice(0, 3).join(".")}`;
	if (reproduced.has(family)) continue;
	reproduced.add(family);
	const input = Schema.decodeSync(Schema.fromJsonString(JoinFuzzInput))(
		await readFile(resolve(directory, `seed-${seed}.json`), "utf8")
	);
	const reduced = await shrinkJoinFuzzInput(input, async (candidate) => {
		let matched = false;
		await withJoinCache(async (cache) => {
			const differences = await compareJoinFuzzInput(candidate, cache).catch(
				joinFuzzException
			);
			matched = differences.some((difference) => difference.field === field);
		});
		return matched;
	});
	const path = resolve(
		directory,
		`${field.replace(/[^a-zA-Z0-9_-]/gu, "-")}-seed-${seed}-reduced.json`
	);
	await writeFile(path, JSON.stringify(reduced, null, 2));
	console.info(`${field}: seed ${seed}; ${reduced.attempts} shrink attempts; ${path}`);
	console.info(JSON.stringify(reduced.input, null, 2));
}
