import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { withJoinCache } from "./columnar-join.test-support.ts";
import {
	joinFuzzInput,
	joinFuzzException,
	compareJoinFuzzInput,
	shrinkJoinFuzzInput
} from "./columnar-join-fuzz.test-support.ts";

// Runs through `pnpm test:game-text:fuzz`, not the ordinary suite; see docs/engineering/testing.md.
it("seeded differential joins match the join planted from the original events", async () => {
	const count = Number(process.env.UE_SHED_JOIN_FUZZ_SEEDS ?? 100);
	const first = Number(process.env.UE_SHED_JOIN_FUZZ_START ?? 0);
	if (!Number.isSafeInteger(count) || count < 1 || !Number.isSafeInteger(first) || first < 0)
		throw new Error("Fuzz seed count must be positive and the first seed nonnegative.");
	const failures = new Map<string, { seed: number; detail: string }>();
	await withJoinCache(async (cache) => {
		for (let seed = first; seed < first + count; seed++) {
			const input = joinFuzzInput(seed);
			const differences = await compareJoinFuzzInput(input, cache).catch(joinFuzzException);
			for (const difference of differences)
				if (!failures.has(difference.field)) {
					failures.set(difference.field, {
						seed,
						detail: difference.detail.slice(0, 1000)
					});
					const directory = resolve("test-results/codex/phase6-fuzz");
					await mkdir(directory, { recursive: true });
					await writeFile(
						resolve(directory, `seed-${seed}.json`),
						JSON.stringify(input, null, 2)
					);
				}
			if ((seed - first + 1) % 100 === 0)
				console.info(
					`Fuzz: ${seed - first + 1}/${count} seeds; ${failures.size} distinct differing fields`
				);
		}
	});
	await mkdir(resolve("test-results/codex/phase6-fuzz"), { recursive: true });
	const summary = JSON.stringify({ count, first, failures: [...failures] }, null, 2);
	await writeFile(resolve("test-results/codex/phase6-fuzz/latest.json"), summary);
	await writeFile(
		resolve("test-results/codex/phase6-fuzz", `run-${process.version}-${first}-${count}.json`),
		summary
	);
	const reproduced = new Set<string>();
	for (const [field, { seed }] of failures) {
		// One shape often changes many nested output fields. Bound shrinking by output family
		// and seed; retain the complete field ledger without repeating equivalent reductions.
		const family = `${seed}:${field.split(".").slice(0, 3).join(".")}`;
		if (reproduced.has(family)) continue;
		reproduced.add(family);
		const reduced = await shrinkJoinFuzzInput(joinFuzzInput(seed), async (candidate) => {
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
			"test-results/codex/phase6-fuzz",
			`${field.replace(/[^a-zA-Z0-9_-]/gu, "-")}-seed-${seed}-reduced.json`
		);
		await writeFile(path, JSON.stringify(reduced, null, 2));
		console.info(
			`Fuzz reproduction: ${field}, seed ${seed}, ${reduced.attempts} shrink attempts: ${path}`
		);
		console.info(JSON.stringify(reduced.input, null, 2));
	}
	expect(failures.size, JSON.stringify([...failures], null, 2)).toBe(0);
}, 3600000);
