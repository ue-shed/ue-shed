import { expect, it } from "vitest";
import { withJoinCache } from "./columnar-join.test-support.ts";
import { joinFuzzInput, compareJoinFuzzInput } from "./columnar-join-fuzz.test-support.ts";

// The seeded sweep is `columnar-join-fuzz-sweep.test.ts`, run by `pnpm test:game-text:fuzz`.
it.each([0, 4, 5, 17, 57, 198, 1000, 9999])("persisted differential seed %i", async (seed) => {
	await withJoinCache(async (cache) => {
		const differences = await compareJoinFuzzInput(joinFuzzInput(seed), cache, true);
		expect(differences, JSON.stringify(differences, null, 2)).toEqual([]);
	});
});
